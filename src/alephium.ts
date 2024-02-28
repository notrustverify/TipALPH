import { NodeProvider, bs58, convertAlphAmountWithDecimals, Destination } from "@alephium/web3";
import { PrivateKeyWallet, deriveHDWalletPrivateKey } from "@alephium/web3-wallet";
import { waitTxConfirmed } from "@alephium/cli";
import { Repository } from "typeorm";
import { Mutex } from 'async-mutex';

import { EnvConfig, FullNodeConfig } from "./config.js";
import * as Error from "./error.js";
import { User } from "./db/user.js";
import { TransactionStatus } from "./transactionStatus.js";
import { TokenAmount, TokenManager, UserBalance } from "./tokenManager.js";

const ALPH_AMOUNT_FOR_OTHER_TOKEN = 0.001;

export class AlphClient {
  private readonly nodeProvider: NodeProvider;
  private readonly mnemonicReader: () => string;
  private userStore: Repository<User>;
  private tokenManager: TokenManager;
  private registerMutex: Mutex;

  constructor(nodeProvider: NodeProvider, mnemonicReader: () => string, userStore: Repository<User>, tokenManager: TokenManager) {
    this.nodeProvider = nodeProvider;
    this.mnemonicReader = mnemonicReader;
    this.userStore = userStore;
    this.tokenManager = tokenManager;
    this.registerMutex = new Mutex();
  }

  private async registerUserExclusive(newUser: User): Promise<User> { // Should use Result<> instead of returning error when user already exists.
    if (await this.userStore.existsBy({ telegramId: newUser.telegramId })) {
      return Promise.reject(Error.ErrorTypes.USER_ALREADY_REGISTERED);
    }
    let userWithId = await this.userStore.save(newUser);
    userWithId.address = this.deriveUserAddress(userWithId);
    return this.userStore.save(userWithId);
  }

  async registerUser(newUser: User): Promise<User> {
    return this.registerMutex.runExclusive(() => this.registerUserExclusive(newUser));
  }

  private deriveUserIterator(user: User): number {
    return user.id;
  }

  private deriveUserAddress(user: User): string {
    return this.getUserWallet(user).address
  }

  getUserWallet(user: User): PrivateKeyWallet {
    const userPrivateKey = deriveHDWalletPrivateKey(this.mnemonicReader(), 'default', this.deriveUserIterator(user));
    return new PrivateKeyWallet({ privateKey: userPrivateKey, nodeProvider: this.nodeProvider });
  }

  async getUserBalance(user: User): Promise<UserBalance> {
    return this.nodeProvider.addresses.getAddressesAddressBalance(user.address)
    .then(async (balance) => {
      console.log(balance);

      const alphToken = await this.tokenManager.getTokenBySymbol("ALPH");
      let userBalance = [new TokenAmount(balance.balance, alphToken)];

      if ("tokenBalances" in balance && undefined !== balance.tokenBalances && balance.tokenBalances.length > 0) {
        const userTokens = await Promise.allSettled(balance.tokenBalances.map(async (t) => this.tokenManager.getTokenAmountFromIdAmount(t.id, t.amount)));
        const recognisedToken = userTokens.filter(t => "fulfilled" === t.status);
        userBalance.push(...recognisedToken.map((t: PromiseFulfilledResult<TokenAmount>) => t.value));
        if (userTokens.length != recognisedToken.length)
          console.log(`${user.toString()} has un-recognised tokens:\n`+ userTokens.filter(t => "rejected" === t.status).map((t: PromiseRejectedResult) => t.reason).join("\n"));
      }

      return userBalance;
    })
    .catch(err => {
      if (Error.alphErrorIsNetworkError(err))
        return Promise.reject(new Error.NetworkError(err));
      else {
        console.error(err);
        return Promise.reject(new Error.GeneralError("failed to fetch user balance", { error: err, context: { user } }));
      }
    });
  }

  async transferFromUserToUser(sender: User, receiver: User, tokenAmount: TokenAmount, txStatus?: TransactionStatus): Promise<string> {
    const senderWallet = this.getUserWallet(sender);

    const newTx = await senderWallet.signAndSubmitTransferTx({
      signerAddress: (await senderWallet.getSelectedAccount()).address,
      destinations: [
        {
          address: receiver.address,
          attoAlphAmount: tokenAmount.token.isALPH() ? tokenAmount.amount : convertAlphAmountWithDecimals(ALPH_AMOUNT_FOR_OTHER_TOKEN),
          ...{ tokens: tokenAmount.token.isALPH() ? [] : [{ id: tokenAmount.token.id, amount: tokenAmount.amount }]}
        }
      ]
    })
    .catch((err) => {
      if (Error.alphErrorIsNetworkError(err))
        return Promise.reject(new Error.NetworkError(err));
      else if (Error.alphErrorIsNotEnoughFundsError(err))
        return Promise.reject(new Error.NotEnoughFundsError(err));
      else if (Error.alphErrorIsNotEnoughBalanceForFeeError(err))
        return Promise.reject(new Error.NotEnoughBalanceForFeeError(err));
      else if (Error.alphErrorIsNotEnoughALPHForTransactionOutputError(err))
        return Promise.reject(new Error.NotEnoughALPHForTransactionOutputError(err));
      else if (Error.alphErrorIsNotEnoughALPHForALPHAndTokenChangeOutputError(err))
        return Promise.reject(new Error.NotEnoughALPHForALPHAndTokenChangeOutputError(err));
      else
        return Promise.reject(err);
    });
    
    if (undefined !== txStatus && !EnvConfig.isOnDevNet())
      txStatus.setTransactionId(newTx.txId).displayUpdate();

    await waitTxConfirmed(this.nodeProvider, newTx.txId, EnvConfig.bot.nbConfirmationsInternalTransfer, 1000);

    // Check for consolidation from time to time
    this.consolidateIfRequired(sender).catch(console.error);
    this.consolidateIfRequired(receiver).catch(console.error);

    return newTx.txId;
  }

  async sendAmountToAddressFrom(user: User, tokenAmount: TokenAmount, destinationAddress: string, txStatus?: TransactionStatus): Promise<string> {
    if (!isAddressValid(destinationAddress))
      return Promise.reject(new Error.InvalidAddressError(destinationAddress));

    const userWallet = this.getUserWallet(user);

    const destinations: Destination[] = [];

    if (EnvConfig.operator.fees > 0) {
      const tokenAmountOperatorFee = tokenAmount.substractAndGetPercentage(EnvConfig.operator.fees);
      console.log(`Collecting ${tokenAmountOperatorFee.toString()} (${EnvConfig.operator.fees}%) fees on ${EnvConfig.operator.address}`);
      destinations.push({
        address: EnvConfig.operator.address,
        attoAlphAmount: tokenAmountOperatorFee.token.isALPH() ? tokenAmountOperatorFee.amount : convertAlphAmountWithDecimals(ALPH_AMOUNT_FOR_OTHER_TOKEN),
        ...{ tokens: tokenAmountOperatorFee.token.isALPH() ? [] : [{ id: tokenAmountOperatorFee.token.id, amount: tokenAmountOperatorFee.amount }]}
      });
    }

    destinations.push({
      address: destinationAddress,
      attoAlphAmount: tokenAmount.token.isALPH() ? tokenAmount.amount : convertAlphAmountWithDecimals(ALPH_AMOUNT_FOR_OTHER_TOKEN),
      ...{ tokens: tokenAmount.token.isALPH() ? [] : [{ id: tokenAmount.token.id, amount: tokenAmount.amount }]}
    });

    console.log(destinations);
    const newTx = await userWallet.signAndSubmitTransferTx({
      signerAddress: (await userWallet.getSelectedAccount()).address,
      destinations,
    })
    .catch((err) => {
      if (Error.alphErrorIsNetworkError(err))
        return Promise.reject(new Error.NetworkError(err));
      else if (Error.alphErrorIsNotEnoughFundsError(err))
        return Promise.reject(new Error.NotEnoughFundsError(err));
      else
        return Promise.reject(err);
    });
    
    if (undefined !== txStatus && !EnvConfig.isOnDevNet())
      txStatus.setTransactionId(newTx.txId).displayUpdate();

    await waitTxConfirmed(this.nodeProvider, newTx.txId, EnvConfig.bot.nbConfirmationsExternalTransfer, 1000);

    // Check for consolidation from time to time
    this.consolidateIfRequired(user).catch(console.error);

    return newTx.txId;
  }

  async consolidateIfRequired(user: User): Promise<string> {
    console.log(`Checking if consolidation is required for user ${user.id}`);
    const userWallet = this.getUserWallet(user);
    return this.nodeProvider.addresses.getAddressesAddressBalance(userWallet.address, { mempool: false })
    .then(async (addressBalance) => { 
      if (addressBalance.utxoNum < EnvConfig.bot.nbUTXOBeforeConsolidation) {
        console.log(`No need to consolidate. Only ${addressBalance.utxoNum} for wallet of user id:${user.id}`);
        return;
      }
      console.log(`Consolidation UTXO for user ${user.id}`);
      const tx = (await this.consolidateUTXO(userWallet)).join(", ");
      console.log(`Consolidated in txId ${tx}`);
      return tx;
    })
    .catch((err) => {
      if (Error.alphErrorIsNetworkError(err))
        return Promise.reject(new Error.NetworkError(err));
      else
        return Promise.reject(err);
    });
  }

  // Inspired from https://github.com/alephium/alephium-web3/blob/master/test/exchange.test.ts#L60
  async consolidateUTXO(userWallet: PrivateKeyWallet): Promise<string[]> {
    return this.nodeProvider.transactions.postTransactionsSweepAddressBuild({
      fromPublicKey: userWallet.publicKey,
      toAddress: userWallet.address,
    })
    .then(sweepResults => 
      sweepResults.unsignedTxs.map(tx => userWallet.signAndSubmitUnsignedTx({ signerAddress: userWallet.address, unsignedTx: tx.unsignedTx }))
    )
    .then(promises => Promise.all(promises))
    .then(txResults => txResults.map(tx => tx.txId))
    .catch((err) => {
      if (Error.alphErrorIsNetworkError(err))
        return Promise.reject(new Error.NetworkError(err));
      else
        return Promise.reject(err);
    });
  }
}

export async function createAlphClient(mnemonicReader: () => string, userStore: Repository<User>, fullnodeInfo: FullNodeConfig, tokenManager: TokenManager): Promise<AlphClient> {
  console.log(`Using ${fullnodeInfo.addr()} as fullnode${fullnodeInfo.apiKey ? " with API key!" : ""}`);
  const nodeProvider = fullnodeInfo.apiKey ? new NodeProvider(fullnodeInfo.addr(), fullnodeInfo.apiKey) : new NodeProvider(fullnodeInfo.addr());

  // Attempt to connect to fullnode (without using the Alephium SDK)
  let selfCliqueReq: Response;
  try {
    selfCliqueReq = await fetch(`${fullnodeInfo.addr()}/infos/self-clique`);
    if (200 !== selfCliqueReq.status)
      return Promise.reject(`fullnode returned ${selfCliqueReq.status} (not 200 OK)`);
  }
  catch (err) {
    return Promise.reject("fullnode is not reachable");
  }
  
  let selfCliqueContent: any;
  try {
    selfCliqueContent = await selfCliqueReq.json();
  }
  catch {
    return Promise.reject("fullnode replied non-json body");
  }
  
  if (!selfCliqueContent.selfReady) {
    console.error(selfCliqueContent);
    return Promise.reject("fullnode is not ready");    
  }
  
  if (!selfCliqueContent.synced) {
    console.error(selfCliqueContent);
    return Promise.reject("fullnode is not synced");
  }

  console.log("NodeProvider is ready and synced!");

  return new AlphClient(nodeProvider, mnemonicReader, userStore, tokenManager);
}

export const isAddressValid = (address: string) =>
  !!address && /^[1-9A-HJ-NP-Za-km-z]+$/.test(address) && bs58.decode(address).slice(1).length >= 32