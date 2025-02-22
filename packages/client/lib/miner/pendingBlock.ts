import { BlobEIP4844Transaction } from '@ethereumjs/tx'
import {
  TypeOutput,
  bigIntToUnpaddedBytes,
  bytesToHex,
  bytesToPrefixedHexString,
  concatBytes,
  equalsBytes,
  toBytes,
  toType,
  zeros,
} from '@ethereumjs/util'
import { BuildStatus } from '@ethereumjs/vm/dist/buildBlock'
import { keccak256 } from 'ethereum-cryptography/keccak'

import type { Config } from '../config'
import type { TxPool } from '../service/txpool'
import type { Block, HeaderData } from '@ethereumjs/block'
import type { TypedTransaction } from '@ethereumjs/tx'
import type { WithdrawalData } from '@ethereumjs/util'
import type { TxReceipt, VM } from '@ethereumjs/vm'
import type { BlockBuilder } from '@ethereumjs/vm/dist/buildBlock'

interface PendingBlockOpts {
  /* Config */
  config: Config

  /* Tx Pool */
  txPool: TxPool

  /* Skip hardfork validation */
  skipHardForkValidation?: boolean
}

export interface BlobsBundle {
  blobs: Uint8Array[]
  commitments: Uint8Array[]
  proofs: Uint8Array[]
}
/**
 * In the future this class should build a pending block by keeping the
 * transaction set up-to-date with the state of local mempool until called.
 *
 * For now this simple implementation just adds txs from the pool when
 * started and called.
 */

// Max two payload to be cached
const MAX_PAYLOAD_CACHE = 2

export class PendingBlock {
  config: Config
  txPool: TxPool

  pendingPayloads: Map<string, BlockBuilder> = new Map()
  blobsBundles: Map<string, BlobsBundle> = new Map()

  private skipHardForkValidation?: boolean

  constructor(opts: PendingBlockOpts) {
    this.config = opts.config
    this.txPool = opts.txPool
    this.skipHardForkValidation = opts.skipHardForkValidation
  }

  pruneSetToMax(maxItems: number): number {
    let itemsToDelete = this.pendingPayloads.size - maxItems
    const deletedItems = Math.max(0, itemsToDelete)

    if (itemsToDelete > 0) {
      // keys are in fifo order
      for (const payloadId of this.pendingPayloads.keys()) {
        this.stop(payloadId)
        itemsToDelete--
        if (itemsToDelete <= 0) {
          break
        }
      }
    }
    return deletedItems
  }

  /**
   * Starts building a pending block with the given payload
   * @returns an 8-byte payload identifier to call {@link BlockBuilder.build} with
   */
  async start(
    vm: VM,
    parentBlock: Block,
    headerData: Partial<HeaderData> = {},
    withdrawals?: WithdrawalData[]
  ) {
    const number = parentBlock.header.number + BigInt(1)
    const { timestamp, mixHash } = headerData
    const { gasLimit } = parentBlock.header

    // payload is uniquely defined by timestamp, parent and mixHash, gasLimit can also be
    // potentially included in the fcU in future and can be safely added in uniqueness calc
    const timestampBuf = bigIntToUnpaddedBytes(toType(timestamp ?? 0, TypeOutput.BigInt))
    const gasLimitBuf = bigIntToUnpaddedBytes(gasLimit)
    const mixHashBuf = toType(mixHash!, TypeOutput.Uint8Array) ?? zeros(32)
    const payloadIdBytes = toBytes(
      keccak256(concatBytes(parentBlock.hash(), mixHashBuf, timestampBuf, gasLimitBuf)).subarray(
        0,
        8
      )
    )
    const payloadId = bytesToPrefixedHexString(payloadIdBytes)

    // If payload has already been triggered, then return the payloadid
    if (this.pendingPayloads.get(payloadId)) {
      return payloadIdBytes
    }

    // Prune the builders and blobsbundles
    this.pruneSetToMax(MAX_PAYLOAD_CACHE)

    if (typeof vm.blockchain.getTotalDifficulty !== 'function') {
      throw new Error('cannot get iterator head: blockchain has no getTotalDifficulty function')
    }
    const td = await vm.blockchain.getTotalDifficulty(parentBlock.hash())
    vm._common.setHardforkByBlockNumber(number, td, timestamp)

    const baseFeePerGas =
      vm._common.isActivatedEIP(1559) === true ? parentBlock.header.calcNextBaseFee() : undefined
    // Set to default of 0 since fee can't be calculated until all blob transactions are added
    const excessDataGas = vm._common.isActivatedEIP(4844) ? BigInt(0) : undefined

    // Set the state root to ensure the resulting state
    // is based on the parent block's state
    await vm.stateManager.setStateRoot(parentBlock.header.stateRoot)

    const builder = await vm.buildBlock({
      parentBlock,
      headerData: {
        ...headerData,
        number,
        gasLimit,
        baseFeePerGas,
        excessDataGas,
      },
      withdrawals,
      blockOpts: {
        putBlockIntoBlockchain: false,
        hardforkByTTD: td,
      },
    })

    this.pendingPayloads.set(payloadId, builder)

    // Get if and how many blobs are allowed in the tx
    let allowedBlobs
    if (vm._common.isActivatedEIP(4844)) {
      const dataGasLimit = vm._common.param('gasConfig', 'maxDataGasPerBlock')
      const dataGasPerBlob = vm._common.param('gasConfig', 'dataGasPerBlob')
      allowedBlobs = Number(dataGasLimit / dataGasPerBlob)
    } else {
      allowedBlobs = 0
    }
    // Add current txs in pool
    const txs = await this.txPool.txsByPriceAndNonce(vm, {
      baseFee: baseFeePerGas,
      allowedBlobs,
    })
    this.config.logger.info(
      `Pending: Assembling block from ${txs.length} eligible txs (baseFee: ${baseFeePerGas})`
    )
    let index = 0
    let blockFull = false
    const blobTxs = []
    while (index < txs.length && !blockFull) {
      try {
        const tx = txs[index]
        await builder.addTransaction(tx, {
          skipHardForkValidation: this.skipHardForkValidation,
        })
        if (tx instanceof BlobEIP4844Transaction) blobTxs.push(tx)
      } catch (error) {
        if (
          (error as Error).message ===
          'tx has a higher gas limit than the remaining gas in the block'
        ) {
          if (builder.gasUsed > gasLimit - BigInt(21000)) {
            // If block has less than 21000 gas remaining, consider it full
            blockFull = true
            this.config.logger.info(
              `Pending: Assembled block full (gasLeft: ${gasLimit - builder.gasUsed})`
            )
          }
        } else {
          // If there is an error adding a tx, it will be skipped
          this.config.logger.debug(
            `Pending: Skipping tx ${bytesToPrefixedHexString(
              txs[index].hash()
            )}, error encountered when trying to add tx:\n${error}`
          )
        }
      }
      index++
    }

    // Construct initial blobs bundle when payload is constructed
    if (vm._common.isActivatedEIP(4844)) {
      this.constructBlobsBundle(payloadId, blobTxs)
    }
    return payloadIdBytes
  }

  /**
   * Stops a pending payload
   */
  stop(payloadIdBytes: Uint8Array | string) {
    const payloadId =
      typeof payloadIdBytes !== 'string' ? bytesToPrefixedHexString(payloadIdBytes) : payloadIdBytes
    const builder = this.pendingPayloads.get(payloadId)
    if (builder === undefined) return
    // Revert blockBuilder
    void builder.revert()
    // Remove from pendingPayloads
    this.pendingPayloads.delete(payloadId)
    this.blobsBundles.delete(payloadId)
  }

  /**
   * Returns the completed block
   */
  async build(
    payloadIdBytes: Uint8Array | string
  ): Promise<void | [block: Block, receipts: TxReceipt[], value: bigint, blobs?: BlobsBundle]> {
    const payloadId =
      typeof payloadIdBytes !== 'string' ? bytesToPrefixedHexString(payloadIdBytes) : payloadIdBytes
    const builder = this.pendingPayloads.get(payloadId)
    if (!builder) {
      return
    }
    const blockStatus = builder.getStatus()
    if (blockStatus.status === BuildStatus.Build) {
      return [blockStatus.block, builder.transactionReceipts, builder.minerValue]
    }
    const { vm, headerData } = builder as unknown as { vm: VM; headerData: HeaderData }

    // get the number of blobs that can be further added
    let allowedBlobs
    if (vm._common.isActivatedEIP(4844)) {
      const bundle = this.blobsBundles.get(payloadId) ?? { blobs: [], commitments: [], proofs: [] }
      const dataGasLimit = vm._common.param('gasConfig', 'maxDataGasPerBlock')
      const dataGasPerBlob = vm._common.param('gasConfig', 'dataGasPerBlob')
      allowedBlobs = Number(dataGasLimit / dataGasPerBlob) - bundle.blobs.length
    } else {
      allowedBlobs = 0
    }

    // Add new txs that the pool received
    const txs = (
      await this.txPool.txsByPriceAndNonce(vm, {
        baseFee: headerData.baseFeePerGas! as bigint,
        allowedBlobs,
      })
    ).filter(
      (tx) =>
        (builder as any).transactions.some((t: TypedTransaction) =>
          equalsBytes(t.hash(), tx.hash())
        ) === false
    )
    this.config.logger.info(`Pending: Adding ${txs.length} additional eligible txs`)
    let index = 0
    let blockFull = false
    let skippedByAddErrors = 0
    const blobTxs = []
    while (index < txs.length && !blockFull) {
      try {
        const tx = txs[index]
        if (tx instanceof BlobEIP4844Transaction) {
          blobTxs.push(tx)
        }
        await builder.addTransaction(tx, {
          skipHardForkValidation: this.skipHardForkValidation,
        })
      } catch (error: any) {
        if (error.message === 'tx has a higher gas limit than the remaining gas in the block') {
          if (builder.gasUsed > (builder as any).headerData.gasLimit - BigInt(21000)) {
            // If block has less than 21000 gas remaining, consider it full
            blockFull = true
            this.config.logger.info(`Pending: Assembled block full`)
          }
        } else if ((error as Error).message.includes('tx has a different hardfork than the vm')) {
          // We can here decide to keep a tx in pool if it belongs to future hf
          // but for simplicity just remove the tx as the sender can always retransmit
          // the tx
          this.txPool.removeByHash(bytesToHex(txs[index].hash()))
          this.config.logger.error(
            `Pending: Removed from txPool tx ${bytesToPrefixedHexString(
              txs[index].hash()
            )} having different hf=${txs[
              index
            ].common.hardfork()} than block vm hf=${vm._common.hardfork()}`
          )
        } else {
          skippedByAddErrors++
          // If there is an error adding a tx, it will be skipped
          this.config.logger.debug(
            `Pending: Skipping tx ${bytesToPrefixedHexString(
              txs[index].hash()
            )}, error encountered when trying to add tx:\n${error}`
          )
        }
      }
      index++
    }

    const block = await builder.build()
    // Construct blobs bundle
    const blobs = block._common.isActivatedEIP(4844)
      ? this.constructBlobsBundle(payloadId, blobTxs)
      : undefined

    const withdrawalsStr = block.withdrawals ? ` withdrawals=${block.withdrawals.length}` : ''
    const blobsStr = blobs ? ` blobs=${blobs.blobs.length}` : ''
    this.config.logger.info(
      `Pending: Built block number=${block.header.number} txs=${
        block.transactions.length
      }${withdrawalsStr}${blobsStr} skippedByAddErrors=${skippedByAddErrors}  hash=${bytesToHex(
        block.hash()
      )}`
    )

    return [block, builder.transactionReceipts, builder.minerValue, blobs]
  }

  /**
   * An internal helper for storing the blob bundle associated with each transaction in an EIP4844 world
   * @param payloadId the payload Id of the pending block
   * @param txs an array of {@BlobEIP4844Transaction } transactions
   * @param blockHash the blockhash of the pending block (computed from the header data provided)
   */
  private constructBlobsBundle = (payloadId: string, txs: BlobEIP4844Transaction[]) => {
    let blobs: Uint8Array[] = []
    let commitments: Uint8Array[] = []
    let proofs: Uint8Array[] = []
    const bundle = this.blobsBundles.get(payloadId)
    if (bundle !== undefined) {
      blobs = bundle.blobs
      commitments = bundle.commitments
      proofs = bundle.proofs
    }

    for (let tx of txs) {
      tx = tx as BlobEIP4844Transaction
      if (tx.blobs !== undefined && tx.blobs.length > 0) {
        blobs = blobs.concat(tx.blobs)
        commitments = commitments.concat(tx.kzgCommitments!)
        proofs = proofs.concat(tx.kzgProofs!)
      }
    }

    const blobsBundle = {
      blobs,
      commitments,
      proofs,
    }
    this.blobsBundles.set(payloadId, blobsBundle)
    return blobsBundle
  }
}
