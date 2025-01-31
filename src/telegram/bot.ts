import { metrics, ValueType } from '@opentelemetry/api';
import { Telegraf, Context, Composer } from "telegraf";
import * as Typegram from "telegraf/types";
import { Repository } from "typeorm";

import { AlphAmountOverflowError, AlphAPIError, AlphApiIOError, ErrorTypes, GeneralError, genLogMessageErrorWhile, genUserMessageErrorWhile, InvalidAddressError, NetworkError, NotEnoughALPHForALPHAndTokenChangeOutputError, NotEnoughALPHForTokenChangeOutputError, NotEnoughALPHForTransactionOutputError, NotEnoughBalanceForFeeError, NotEnoughFundsError, TooSmallALPHWithdrawalError } from "../error.js";
import { ALPHSymbol, TokenManager } from "../tokens/tokenManager.js";
import { genTxIdText, TransactionStatus } from "../transactionStatus.js";
import { TokenAmount } from "../tokens/tokenAmount.js";
import { Command } from "./commands/command.js";
import { AlphClient } from "../services/alephium.js";
import { EnvConfig } from "../config.js";
import { User } from "../db/user.js";
import { DUST_AMOUNT, prettifyAttoAlphAmount } from "@alephium/web3";
import { LeavingService } from "../services/leavingService.js";

let bot: Telegraf;

const meter = metrics.getMeter('telegram');

export const editLastMsgWith = async (ctx: Context<Typegram.Update.MessageUpdate>, lastMsg: Typegram.Message.TextMessage, newText: string, isHTML: boolean = true, linkPreview: boolean = true) => {
  const parse_mode = isHTML ? "HTML" : "Markdown";
  await ctx.telegram.editMessageText(lastMsg.chat.id, lastMsg.message_id, undefined, newText, { parse_mode, link_preview_options: { is_disabled: !linkPreview } }).catch(console.error);
};

export async function runTelegram(alphClient: AlphClient, userRepository: Repository<User>, tokenManager: TokenManager) {
  console.log("Starting Telegram bot...");
  
  bot = new Telegraf(EnvConfig.telegram.bot.token);

  const leavingService = new LeavingService(EnvConfig.expirationDelay);

  const commands: Command[] = [];

  /**
   * Utility functions
   */

  const getUserFromTgId = (telegramId: number): Promise<User> => userRepository.findOneBy({ telegramId });

  const getUserFromTgUsername = (telegramUsername: string): Promise<User> => userRepository.findOneBy({ telegramUsername });
  
  /**
   * Command functions
   */
  const startFct = async (ctx: Context<Typegram.Update.MessageUpdate>) => {
    if ("private" !== ctx.update.message.chat.type) {
      return;
    }

    const username = ctx.from.username;
    const userId = ctx.message.from.id;

    // Initial message
    let msg = `Hi ${username}!\n\n`;
    msg += `With @${ctx.me}, you can tip ALPH to other telegram users!\n`;
    msg += "Please bear in mind that:\n";
    msg += " - the bot is still in alpha\n";
    msg += " - the wallet linked to your account is custodial (we hold the mnemonic) so please do not put too much money on it";
    await ctx.sendMessage(msg);

    // Creation of wallet
    let user = new User(userId, username);
    user = await ctx.sendMessage("Initializing a new wallet...")
    .then(lastTgMsg => {
      console.log(`Attempt to register "${user.telegramUsername}" (id: ${user.telegramId})`);
      return alphClient.registerUser(user)
      .then(user => {
        console.log(`Registered "${user.telegramUsername}" (id: ${user.telegramId})`);
        let msg = `Your wallet has been initialized!\nHere's your adresse:\n<code>${user.address}</code>\n`;
        msg += "Ask users to <code>/tip</code> you or send some tokens to it.\n",
        msg += "Download the <a href='https://alephium.org/#wallets'>wallets</a>!";
        editLastMsgWith(ctx, lastTgMsg, msg);
        return user;
      })
      .catch((err) => {
        if (ErrorTypes.USER_ALREADY_REGISTERED !== err) {
          console.error(genLogMessageErrorWhile("initilize wallet (UN-EXPECTED)", err, user));
          return null;
        }
        editLastMsgWith(ctx, lastTgMsg, "You already have an initialized account!");
        return getUserFromTgId(userId);
      });
    });

    if (null === user) {
      ctx.sendMessage(genUserMessageErrorWhile("ensuring the initialization of your account"));
      return;
    }

    // Display balance
    sendBalanceMessage(ctx, user);
  };

  const addressFct = async (ctx: Context<Typegram.Update.MessageUpdate>) => {
    if ("private" !== ctx.update.message.chat.type) {
      return;
    }
    const user = await getUserFromTgId(ctx.message.from.id);
    if (null === user) {
      ctx.sendMessage(ErrorTypes.UN_INITIALIZED_WALLET, { parse_mode: "Markdown" });
      return;
    }
    sendAddressMessage(ctx, user);
  };

  const sendAddressMessage = (ctx: Context<Typegram.Update.MessageUpdate>, user: User) => {
    const link = undefined !== EnvConfig.explorerAddress() ? `its status <a href="${EnvConfig.explorerAddress()}/addresses/${user.address}">here</a> and ` : "";
    ctx.sendMessage(`Your address is <code>${user.address}</code>.\nYou can see ${link}your balance with /balance.`, { parse_mode: "HTML" });
  };
  
  const sendBalanceMessage = (ctx: Context<Typegram.Update.MessageUpdate>, user: User) => {
    alphClient.getUserBalance(user)
    .then(userBalance => {
      let balanceMsg = "Your account currently holds:"
      if (1 === userBalance.length && userBalance[0].token.isALPH())
        ctx.sendMessage(`${balanceMsg} ${userBalance[0].toString()}`);
      else {
        balanceMsg += "\n";
        balanceMsg += userBalance.map(u => ` &#8226; ${u.toString()}`).join("\n");
        ctx.sendMessage(balanceMsg, { parse_mode: "HTML" });
      }
    })
    .catch(err => {
      ctx.sendMessage(genUserMessageErrorWhile("retrieving your account balance"));
      console.error(genLogMessageErrorWhile("fetch balance", err, user));
    });
  };

  const balanceFct = async (ctx: Context<Typegram.Update.MessageUpdate>) => {
    if ("private" !== ctx.update.message.chat.type) {
      return;
    }

    const user = await getUserFromTgId(ctx.message.from.id);
    if (null === user) {
      ctx.sendMessage(ErrorTypes.UN_INITIALIZED_WALLET, { parse_mode: "Markdown" });
      return;
    }
    
    sendBalanceMessage(ctx, user);
  };

  const tipSuccessCounter = meter.createCounter(`telegram.tip.success.counter`,{
    description: `A counter for the number of times the tip command has been processed successfully`,
    valueType: ValueType.INT,
  });

  let usageTip = "To tip @user 1 $TOKEN, either:\n - tag it: `/tip 1 $TOKEN @user`\n - reply to one of user's message with: `/tip 1 $TOKEN`\n";
  usageTip += "If you want to tip $ALPH, you can omit the $TOKEN\n";
  usageTip += "You can also add a reason in the end of each command.";
  const tipFct = async (ctx: Context<Typegram.Update.MessageUpdate>) => {
    if (!("text" in ctx.message))
      return;
    
    const sender = await getUserFromTgId(ctx.message.from.id);
    if (null === sender) {
      ctx.sendMessage(ErrorTypes.UN_INITIALIZED_WALLET, { parse_mode: "Markdown" });
      return;
    }

    const isReply = "reply_to_message" in ctx.message && undefined !== ctx.message.reply_to_message; // && "supergroup" !== ctx.chat.type;

    const messageText = ctx.message.text as string;
    const payload: string = messageText.trim();
    const tipAmountUserRegex = /^\/tipa?(?:@\w+)?\s+(?<amountAsString>\d+(?:[.,]\d+)?)(?:\s+\$(?<tokenSymbol>[a-zA-Z]{2,}))?\s+@(?<receiverUsername>[a-zA-Z0-9_]{4,32})(?:\s+(?<reason>.*))?/;
    const tipAmountRegex = /^\/tipa?(?:@\w+)?\s+(?<amountAsString>\d+(?:[.,]\d+)?)(?:\s+\$(?<tokenSymbol>[a-zA-Z]{2,}))?(?:\s+(?<reason>.*))?/;

    // These are the values that we are trying to determine
    let amountAsString: string;
    let tokenSymbol: string;
    let receiverUsername: string;
    let reason: string;

    let receiver: User;
    let msgToReplyTo: number;
    let wasNewAccountCreated = false;

    let args: RegExpMatchArray;
    console.log(ctx.message);
    console.log(`Payload: "${payload}"`);
    console.log("isReply?", "reply_to_message" in ctx.message, undefined !== ctx.message.reply_to_message, "supergroup" !== ctx.chat.type, "=>", isReply);
    console.log(tipAmountUserRegex.exec(payload));
    console.log(tipAmountRegex.exec(payload));
    if (!isReply && (args = tipAmountUserRegex.exec(payload)) && undefined !== args.groups && ({ amountAsString, tokenSymbol, receiverUsername, reason } = args.groups) && undefined !== amountAsString && undefined !== receiverUsername) {
      console.log("By tagging", amountAsString, tokenSymbol, receiverUsername, reason);

      receiver = await getUserFromTgUsername(receiverUsername);
      if (null === receiver) {
        console.log("User does not exist. Cannot create an account.");
        ctx.sendMessage("This user hasn't initialized their wallet yet.. You can initialize a wallet for this user by tipping in response.");
        return;
      }

    }
    else if (isReply && (args = payload.match(tipAmountRegex)) && undefined !== args.groups && ({ amountAsString, tokenSymbol, reason } = args.groups) && undefined !== amountAsString) {
      console.log("By reply", amountAsString, tokenSymbol, reason);

      if (undefined === ctx.message.reply_to_message) {
        ctx.sendMessage("I am sorry but I cannot see the message you are replying to 🤷");
        return;
      }

      if (tokenSymbol === undefined && reason !== undefined && 0 < reason.length) {
        const tokenInReason = await tokenManager.getTokenByCaseInsensitiveSymbol(reason.split(" ")[0])
        if (tokenInReason !== null) {
          console.warn("User might have forgotten the $ sign before the token");
          ctx.sendMessage(`It seems that you might be trying to tip $${tokenInReason.symbol} but forgot the $ sign.. If you really want to tip $${tokenInReason.symbol}, add the $! `);
          return;
        }
      }

      receiver = await getUserFromTgId(ctx.message.reply_to_message.from.id);
      if (null === receiver) {

        if (undefined === ctx.message.reply_to_message.from.username) {
          ctx.sendMessage("It seems that this user has no publicly accessible Telegram username.\nUnfortunately, this is required to have a wallet…", { reply_parameters: { message_id: ctx.message.message_id } });
          return;
        }

        const newUser = new User(ctx.message.reply_to_message.from.id, ctx.message.reply_to_message.from.username);
        console.log(`${newUser} does not exist, attempt creating an account`);
        try {
          receiver = await alphClient.registerUser(newUser);
          wasNewAccountCreated = true;
          console.log(`"${sender.telegramUsername}" (id: ${sender.telegramId}) created a wallet for "${receiver.telegramUsername}" (id: ${receiver.telegramId}) by tipping!`);
        }
        catch (err) {
          console.error(new GeneralError("failed to register new user while tipping", {
            error: err,
            context: { newUser, sender, amountAsString }
          }))
          ctx.sendMessage(`An error occured while creating a new wallet for ${newUser.telegramUsername}`,  { reply_parameters: { message_id: ctx.message.message_id } });
          return;
        }
      }

      msgToReplyTo = ctx.message.reply_to_message.message_id;
    }
    else {
      ctx.sendMessage(usageTip, { parse_mode: "Markdown" });
      return;
    }

    // If token is undefined, consider it is ALPH
    tokenSymbol = undefined === tokenSymbol ? ALPHSymbol : tokenSymbol;

    const tokenAmount = await tokenManager.getTokenAmountByTokenSymbol(tokenSymbol, amountAsString);
    if (undefined === tokenAmount) {
      ctx.sendMessage("The token is invalid",  { reply_parameters: { message_id: msgToReplyTo } });
      return;
    }

    // As AlphClient only allows for . as delimiter
    amountAsString = amountAsString.replace(",", ".");

    console.log(`${sender.telegramId} tips ${tokenAmount.toString()} to ${receiver.telegramId} (Motive: "${reason}")`);

    const txStatus = new TransactionStatus(`@${sender.telegramUsername} tipped @${receiver.telegramUsername}`, tokenAmount.toString());
    const setResponseTo = undefined !== msgToReplyTo ? { reply_to_message_id: msgToReplyTo } : { };
    const previousReply = await ctx.sendMessage(txStatus.toString(), { parse_mode: "HTML", ...setResponseTo });
    txStatus.setDisplayUpdate(async (update: string) => editLastMsgWith(ctx, previousReply, update));

    // Now that we know the sender, receiver and amount, we can proceed to the transfer
    alphClient.transferFromUserToUser(sender, receiver, tokenAmount, txStatus)
    .then(txId => {
      txStatus.setConfirmed().setTransactionId(txId).displayUpdate();

      /*
       * We eventually notify people that received tips
       */
      if (wasNewAccountCreated)
        ctx.sendMessage(`@${receiver.telegramUsername}!` + " You received a tip! Hit `Start` on @" + ctx.me + " to access your account!", { parse_mode: "Markdown" });
      // If sender tipped by tagging, receiver should get a notification (if not bot) (receiver might not be in the chat where tip was ordered)
      else if (!isReply && ctx.botInfo.id != receiver.telegramId)
        ctx.telegram.sendMessage(receiver.telegramId, `You received ${tokenAmount.toString()} from @${sender.telegramUsername} ${genTxIdText(txId)}`, { parse_mode: "HTML" });
    
      tipSuccessCounter.add(1);
    })
    .catch((err) => {
      console.log(err);
      if (err instanceof NetworkError) {
        console.error(genLogMessageErrorWhile("tipping", err.message, sender));
      }
      if (err instanceof AlphApiIOError) {
        console.error(err.message);
        ctx.telegram.sendMessage(sender.telegramId, "Oops. It seems that a someone twisted a cable somewhere. You should try again, it might work now. If not, please reach us!");
      }
      else if (err instanceof NotEnoughFundsError) {
        console.error(genLogMessageErrorWhile("tipping", err.message, sender));
        const requiredTokenAmount = new TokenAmount(err.requiredFunds(), tokenAmount.token);
        const actualTokenAmount = new TokenAmount(err.actualFunds(), tokenAmount.token);
        ctx.telegram.sendMessage(sender.telegramId, `You cannot send ${requiredTokenAmount.toString()} to ${receiver.telegramUsername}, since you only have ${actualTokenAmount.toString()}`);
      }
      else if (err instanceof NotEnoughBalanceForFeeError) {
        console.error(genLogMessageErrorWhile("tipping", err.message, sender));
        ctx.telegram.sendMessage(sender.telegramId, `You do not have enough balance to handle the gas fees. You can maybe try again with a lower amount`);
      }
      else if (err instanceof AlphAmountOverflowError) {
        console.error(err);
        ctx.telegram.sendMessage(sender.telegramId, "It seems that you are trying to tip too large amounts. Try with smaller one!\nP.S.: You should not have that much on your account btw...");
      }
      else if (err instanceof NotEnoughALPHForTransactionOutputError) {
        console.error(genLogMessageErrorWhile("tipping", err.message, sender));
        ctx.telegram.sendMessage(sender.telegramId, `You cannot tip less than ${prettifyAttoAlphAmount(DUST_AMOUNT)} $ALPH`);
      }
      else if (err instanceof NotEnoughALPHForALPHAndTokenChangeOutputError) {
        console.error(genLogMessageErrorWhile("tipping", err.message, sender));
        ctx.telegram.sendMessage(sender.telegramId, "You do not have enough $ALPH to transfer this token");
      }
      else if (err instanceof NotEnoughALPHForTokenChangeOutputError) {
        console.error(genLogMessageErrorWhile("tipping", err.message, sender));
        ctx.telegram.sendMessage(sender.telegramId, "You cannot make that tip since you need to keep funds to take out your $ALPH and token");
      }
      else {
        console.error(new GeneralError("failed to tip", {
          error: err,
          context: { "sender_id": sender.id, "received_id": receiver.id, "amount": amountAsString }
        }));
      }

      txStatus.setFailed().displayUpdate();
    });
  };

  const withdrawSuccessCounter = meter.createCounter(`telegram.withdraw.success.counter`,{
    description: `A counter for the number of times the withdraw command has been processed successfully`,
    valueType: ValueType.INT,
  });

  let usageWithdrawal = "Send:\n";
  usageWithdrawal += " &#8226; <code>/withdraw 1 $TOKEN address</code> to withdraw 1 $TOKEN to <em>address</em>.\n";
  usageWithdrawal += " &#8226; <code>/withdraw 1 address</code> to withdraw 1 $ALPH to <em>address</em>.\n";
  usageWithdrawal += " &#8226; <code>/withdraw all $TOKEN address</code> to withdraw all your $TOKEN to <em>address</em>.\n";
  usageWithdrawal += " &#8226; <code>/withdraw all address</code> to withdraw all your coins to <em>address</em>.\n";
  usageWithdrawal += (EnvConfig.operator.fees > 0 ? `\n${EnvConfig.operator.fees}% withdrawal fee will be deducted from your withdrawals.` : "");
  const withdrawFct = async (ctx: Context<Typegram.Update.MessageUpdate>) => {
    if ("private" !== ctx.message.chat.type || !("text" in ctx.message))
      return;

    const sender = await getUserFromTgId(ctx.message.from.id);
    if (null === sender) {
      ctx.sendMessage(ErrorTypes.UN_INITIALIZED_WALLET, { parse_mode: "Markdown" });
      return;
    }

    const messageText = ctx.message.text as string;
    const payload: string = messageText.trim();
    const sendAmountDestRegex = /^\/withdraw(?:@\w+)?\s+(?:(?<amountAsString>\d+(?:[.,]\d+)?)|all)(\s+\$(?<tokenSymbol>[a-zA-Z]{2,}))?\s+(?<destinationAddress>[a-zA-Z0-9]+)$/;

    // These are the values that we are trying to determine
    let amountAsString: string;
    let tokenSymbol: string
    let destinationAddress: string;

    let args: RegExpMatchArray;
    args = sendAmountDestRegex.exec(payload);
    console.log(args);
    if (null === (args = sendAmountDestRegex.exec(payload)) || !("groups" in args) || !args.groups || !({ amountAsString, tokenSymbol, destinationAddress } = args.groups) || undefined === destinationAddress) {
      ctx.sendMessage(usageWithdrawal, { parse_mode: "HTML" });
      return;
    }

    const msgToReplyTo = ctx.message.message_id;
    let promisedWithdrawalTxString: Promise<string>;
    let txStatus: TransactionStatus;
    let tokenAmount: TokenAmount;

    // If there's only an address, user sent `withdraw all`
    if (undefined === amountAsString && undefined === tokenSymbol) {

      txStatus = new TransactionStatus(`Withdrawal to ${destinationAddress}\n&#9888; This will take some time...`, ["Take operator fees", "Send your funds"]);
      const lastMsg = await ctx.sendMessage(txStatus.toString(), { reply_parameters: { message_id: msgToReplyTo }, parse_mode: "HTML" });
      txStatus.setDisplayUpdate((async (update: string) => editLastMsgWith(ctx, lastMsg, update)));

      console.log(`${sender.telegramId} sends everything to ${destinationAddress}`);

      promisedWithdrawalTxString = alphClient.takeFeesAndSweepWalletFromUserTo(sender, destinationAddress, txStatus);
    }
    else {

      // If token is undefined, consider it is ALPH
      tokenSymbol = undefined === tokenSymbol ? ALPHSymbol : tokenSymbol;
      const token = await tokenManager.getTokenByCaseInsensitiveSymbol(tokenSymbol);
      if (undefined === token) {
        ctx.sendMessage("The token is invalid or does not exist.", { reply_parameters: { message_id: msgToReplyTo } });
        return;
      }

      // If there's only an address and a token, user sent `withdraw all $token`
      if (undefined === amountAsString) {
        const userBalance = await alphClient.getUserBalance(sender)
        if (1 < userBalance.length && token.isALPH()) {
          ctx.sendMessage(`Withdrawing only all your $ALPH is not allowed as you need some for your other tokens.\nTry to withdraw everything with <code>/withdraw all ${destinationAddress}</code>`, { reply_parameters: { message_id: msgToReplyTo }, parse_mode: "HTML" });
          return;
        }

        const filteredUserBalance = userBalance.filter(t => t.token.id === token.id);
        if (0 === filteredUserBalance.length) {
          console.log(`user ${sender.id} has no $${token.symbol}`);
          ctx.sendMessage(`You do not have any $${token.symbol}`, { reply_parameters: { message_id: msgToReplyTo } });
          return;
        }

        tokenAmount = filteredUserBalance[0];

        console.log(`${sender.telegramId} sends all (i.e. ${tokenAmount.amountAsNumber()}) $${tokenSymbol} to ${destinationAddress}`);
        txStatus = new TransactionStatus(`Withdrawal to ${destinationAddress}`, `all your ${tokenAmount.toString()}`);
      }
      // If there's an amount, user does want to send a specific amount,
      else {

        // As AlphClient only allow for . as delimiter
        amountAsString = amountAsString.replace(",", ".");

        tokenAmount = new TokenAmount(amountAsString, token, true);

        console.log(`${sender.telegramId} sends ${tokenAmount.toString()} to ${destinationAddress}`);
        txStatus = new TransactionStatus(`Withdrawal to ${destinationAddress}`, tokenAmount.toString());
      }

      const lastMsg = await ctx.sendMessage(txStatus.toString(), { reply_parameters: { message_id: msgToReplyTo }, parse_mode: "HTML" });
      txStatus.setDisplayUpdate((async (update: string) => editLastMsgWith(ctx, lastMsg, update)));
      
      promisedWithdrawalTxString = alphClient.sendAmountToAddressFrom(sender, tokenAmount, destinationAddress, txStatus);
    }
    
    promisedWithdrawalTxString?.then(txId => {
      console.log("Withdraw successfull!");
      withdrawSuccessCounter.add(1);
      if (0 < txId.length)
        txStatus.setTransactionId(txId);
      txStatus.setConfirmed().displayUpdate();
    })
    .catch((err) => {
      if (err instanceof NetworkError) {
        console.error(genLogMessageErrorWhile("withdrawal", err.message, sender));
      }
      else if (err instanceof InvalidAddressError) {
        ctx.sendMessage(`The provided address (${err.invalidAddress()}) seems invalid.`);
        console.error(genLogMessageErrorWhile("withdrawal", err, sender));
      }
      else if (err instanceof NotEnoughFundsError) {
        console.error(genLogMessageErrorWhile("withdrawal", err.message, sender));
        const requiredTokenAmount = new TokenAmount(err.requiredFunds(), tokenAmount.token);
        const actualTokenAmount = new TokenAmount(err.actualFunds(), tokenAmount.token);
        ctx.sendMessage(`You cannot withdraw ${requiredTokenAmount.toString()}, since you only have ${actualTokenAmount.toString()}`, { reply_parameters: { message_id: ctx.message.message_id } });
      }
      else if (err instanceof TooSmallALPHWithdrawalError) {
        console.error(genLogMessageErrorWhile("tipping", err.message, sender));
        ctx.telegram.sendMessage(sender.telegramId, `You have to withdraw more than ${EnvConfig.operator.strictMinimalWithdrawalAmount} $ALPH.`);
      }
      else if (err instanceof AlphAmountOverflowError) {
        console.error(err);
        ctx.telegram.sendMessage(sender.telegramId, "It seems that you are trying to withdraw too large amounts. Try with smaller one!\nP.S.: You should not have that much on your account btw...");
      }
      else if (err instanceof AlphAPIError) {
        console.error("API error", err);
      }
      else {
        console.error(err);
        //console.error(new GeneralError("withdrawal", { error: err, context: { sender, amountAsString, destinationAddress } }));
      }

      txStatus.setFailed().displayUpdate();
    });
  };

  const convertTimeSecToMinSec = (nbSeconds: number): string => {
    if (nbSeconds < 60)
      return `${Math.floor(nbSeconds)} second` + (nbSeconds > 2 ? "s" : "");
    else {
      const nbMinutes = Math.floor(nbSeconds/60);
      return `${nbMinutes} minute` + (nbMinutes > 2 ? "s" : "");
    }
  };

  const tokenListFct = async (ctx: Context<Typegram.Update.MessageUpdate>) => {
    let tokenslistMsg = "List of tokens:\n\n";
    tokenslistMsg += tokenManager.getTokensAsHTML();
    tokenslistMsg += `\n\n<em>Next update in ${convertTimeSecToMinSec(tokenManager.nextTokenUpdate())}</em>`;
    ctx.sendMessage(tokenslistMsg, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  };
  
  const privacyFct = async (ctx: Context<Typegram.Update.MessageUpdate>) => {
    if ("private" !== ctx.message.chat.type)
      return;

    let privacyMessage = `I, ${ctx.me} 🤖, hereby promise that I will only collect your:\n`;
    privacyMessage += "\t\t- Telegram ID\n";
    privacyMessage += "\t\t- Telegram username\n";
    privacyMessage += "\nThese are associated it with an Alephium address and an ID that I use to remember you\n";
    privacyMessage += "This is the minimal amount of data I need to know and store in order to enable you to tip other Alephium enthusiasts.\n";
    privacyMessage += "\nWhile I receive every message that is sent in the chats I am in (to allow you to command me), I do not consider them if they are not for me.";
    privacyMessage += "\nIf you want me to forget about you and delete the data I have about you, you can run /forgetme";
    ctx.sendMessage(privacyMessage);
  };
  
  const usageForgetMe = `Send <code>/forgetme</code> to ask me to forget you.`;
  const forgetMeInitiatedCounter = meter.createCounter(`telegram.forgetme.initiated.counter`,{
    description: `A counter for the number of times the forgetme process has been initiated`,
    valueType: ValueType.INT,
  });
  const forgetMeSuccessCounter = meter.createCounter(`telegram.forgetme.success.counter`,{
    description: `A counter for the number of times the forgetme command has been processed successfully`,
    valueType: ValueType.INT,
  });
  const forgetmeFct = async (ctx: Context<Typegram.Update.MessageUpdate>) => {
    if ("private" !== ctx.message.chat.type || !("text" in ctx.message))
      return;

    const user = await getUserFromTgId(ctx.message.from.id);
    if (null === user) {
      ctx.sendMessage(ErrorTypes.FORGET_NON_REGISTRERED_USER);
      return;
    }

    // Did the user already registered?
    const previouslyRegistered = await leavingService.didUserAlreadyRegisteredIntention(user);
    const goodByeMessageForUser = `GoodBye-From-${user.telegramUsername}`;
    const payload: string = (ctx.message.text as string).trim();
    
    const forgetMeRegex = /^\/forgetme(?:@\w+)?(?:\s+(?<userProvidedGoodByeString>[a-zA-Z0-9\-_]{15,45}))?$/;
    let userProvidedGoodByeString: string;
    let userProvidedGoodByeMessage: string;

    let args: RegExpMatchArray = forgetMeRegex.exec(payload);
    if (null !== args && ("groups" in args) && undefined !== args.groups && undefined !== ({ userProvidedGoodByeString } = args.groups) && undefined !== userProvidedGoodByeString)
      userProvidedGoodByeMessage = userProvidedGoodByeString;

    if (!previouslyRegistered) {
      if (undefined !== userProvidedGoodByeMessage) {
        ctx.sendMessage(usageForgetMe, { parse_mode: "HTML", reply_parameters: { message_id: ctx.message.message_id } });
        return;
      }

      console.log(`User ${user.id} wants to be forgotten`);
      await leavingService.registerLeavingIntention(user);

      let byeMessage = "Note that by asking me to forget you, you will no longer be able to access your funds.\nPlease confirm your intention by sending"
      byeMessage += `<code>/forgetme ${goodByeMessageForUser}</code> in the next ${EnvConfig.expirationDelay/1000} seconds.`
      ctx.sendMessage(byeMessage, { parse_mode: "HTML", reply_parameters: { message_id: ctx.message.message_id } });
      forgetMeInitiatedCounter.add(1);
    }
    else if (previouslyRegistered) {
      if (userProvidedGoodByeMessage === goodByeMessageForUser) {
        console.log(`User ${user.id} confirmed their intention to be forgotten! Removing from database`);

        await leavingService.removeUserLeavingIntention(user);

        // Sweeping wallet
        const txs = await alphClient.emptyWalletForDeletion(user);
        console.log(`User wallet emptied! Txs: ${txs.join(", ")}`);

        // Deleting account
        await alphClient.deleteUser(user);
        
        ctx.sendMessage(`Your account have successfully been deleted. To use me again, send <code>/start</code>`, { parse_mode: "HTML", reply_parameters: { message_id: ctx.message.message_id } });
        forgetMeSuccessCounter.add(1);
      }
      else {
        leavingService.removeUserLeavingIntention(user);
        ctx.sendMessage("Wrong confirmation code. We'll do as if you never asked me to forget you…", { reply_parameters: { message_id: ctx.message.message_id } });
      }
    }
  };

  const helpFct = (ctx: Context<Typegram.Update.MessageUpdate>) => {
    let helpMessage = "Here is the list of commands that I handle in this context:\n\n";
    let commandsToDisplay = commands;

    if ("private" !== ctx.message.chat.type)
      commandsToDisplay = commandsToDisplay.filter(c => !c.isPrivate)

    helpMessage += commandsToDisplay.map(c => c.getHelpMessage()).join("\n");
    helpMessage += "\n\nDownload the wallets here: https://alephium.org/#wallets";
    ctx.sendMessage(helpMessage, { parse_mode: "Markdown", link_preview_options: { is_disabled: true } });
  };

  /**
   * Middlewares
   */

  // Ensure that bot is registered
  bot.use(async (ctx: Context<Typegram.Update>, next) => {
    if (0 === (await userRepository.count())) {
      await alphClient.registerUser(new User(ctx.botInfo.id, ctx.botInfo.username));
    }
    await next();
  });

  // Middleware filters out messages that are forwarded
  bot.use(async (ctx: Context<Typegram.Update>, next) => {
    if (!("forward_origin" in ctx.message && undefined !== ctx.message.forward_origin))
      await next();
  });

  // This middleware to restrict to Admin UIDs, if desired
  bot.use(async (ctx: Context<Typegram.Update>, next) => {
    const adminUIDs = EnvConfig.telegram.admins;
    if (!EnvConfig.bot.onlyAllowAdmins || 0 === adminUIDs.length) { // If no admin is specified, we allow everyone
      await next();
    }
    else {
      const isAdmin: boolean = ("message" in ctx.update && adminUIDs.includes(ctx.update.message.from.id));// || ("edited_message" in ctx.update && adminUIDs.includes(ctx.update["edited_message"]["from"]["id"]))
      if (process.env.TG_ADMIN_UIDS && isAdmin)
        await next();
      else  // If whitelist but user attempts to use anyway, we display its id, to be added
        console.log(`"${ctx.message.from.username}" (id: ${ctx.message.from.id}) wants to join!`);
    }
  });

  // Prevent Bots from exchanging messages to prepare overruling the world
  bot.use(async (ctx: Context<Typegram.Update>, next) => {
    if ("from" in ctx && undefined !== ctx.from && !ctx.from.is_bot)
      await next();
  });

  bot.use(async (ctx: Context<Typegram.Update>, next) => {
    const t0 = performance.now()
    await next() // runs next middleware
    const t1 = performance.now()
    console.log(`Processing update ${ctx.update.update_id} from user id ${ctx.from.id} (${(t1-t0).toFixed(3)} ms)`)
  });

  /**
   * Linking of functions with commands
   */

  commands.push(
    new Command("start", "initialize your account with the bot", startFct, true),
    new Command("address", "display the address of your account", addressFct, true),
    new Command("balance", "display the balance of your account", balanceFct, true),
    new Command("tip", "tip amount to a user", tipFct, false, usageTip, ["tipa"]),
    new Command("withdraw", "send amount to the ALPH address" + (EnvConfig.operator.fees > 0 ? ` (bot takes ${EnvConfig.operator.fees}% fees!)` : ""), withdrawFct, true, usageWithdrawal),
    new Command("tokens", "display the list of recognized token", tokenListFct, false),
    new Command("privacy", "display the data protection policy of the bot", privacyFct, true),
    new Command("forgetme", "ask the bot to forget about you", forgetmeFct, true),
    new Command("help", "display help", helpFct, false),
  );

  /*
   * Register the commands
   */
  for (const cmd of commands) {
    bot.command(cmd.name, cmd.getProcess());

    for (const alias of cmd.getAliases())
      bot.command(alias, cmd.getProcess(alias));
  }

  /*
   * Admin commands
   */

  const statsFct = async (ctx: Context<Typegram.Update.MessageUpdate>) => {
    let msgStats = `<b>${await userRepository.count()}</b> accounts created\n\n`;
    const totalBalance = await alphClient.getTotalTokenAmount();
    msgStats += "TVL:\n"
    msgStats += totalBalance.map(t => ` &#8226; ${t.toString()}`).join("\n");

    ctx.sendMessage(msgStats, { parse_mode: "HTML" });
  }

  const feesFct = async (ctx: Context<Typegram.Update.MessageUpdate>) => {
    let msgFees = "Addresses for fees collection:\n";
    msgFees += EnvConfig.operator.addressesByGroup.map((a, i) => ` &#8226; G${i}: <a href="${EnvConfig.explorerAddress()}/addresses/${a}" >${a}</a>`).join("\n");

    const collectionFeesAddressses: string[] = [];
    for (const addr of EnvConfig.operator.addressesByGroup)
      collectionFeesAddressses.push(addr);
    
    const totalFees = await alphClient.getTotalTokenAmountFromAddresses(collectionFeesAddressses);
  
    msgFees += "\n\nTotal fees collected\n";
    msgFees += totalFees.map(t => ` &#8226; ${t.toString()}`).join("\n");

    ctx.sendMessage(msgFees, { parse_mode: "HTML" });
  };

  const versionFct = (ctx: Context<Typegram.Update.MessageUpdate>) => {
    ctx.sendMessage(EnvConfig.version, { reply_parameters: { message_id: ctx.message.message_id } });
  };

  const adminCommands = [
    new Command("stats", "Display stats about the bot", statsFct, false),
    new Command("fees", "Display collected fees so far", feesFct, false),
    new Command("version", "Display TipALPH version", versionFct, false),
  ];

  /*
   * Register the admin commands
   */
  const adminBot = new Composer();
  for (const cmd of adminCommands) {
    adminBot.command(cmd.name, cmd.getProcess());

    for (const alias of cmd.getAliases())
      adminBot.command(alias, cmd.getProcess(alias));
  }

  bot.use(Composer.acl(EnvConfig.telegram.admins, adminBot));

  /**
   * Signal handling and start of signal
   */
  const stopBot = (signal: string) => {
    console.log(`Stopping Telegram bot after receiving ${signal}`);
    bot.stop(signal);
  }
  process.once('SIGINT', () => { tokenManager.stopCron(); stopBot('SIGINT'); });
  process.once('SIGTERM', () => { tokenManager.stopCron(); stopBot('SIGTERM'); });

  // Filter to only receive messages updates
  // https://telegraf.js.org/interfaces/Telegraf.LaunchOptions.html#allowedUpdates
  bot.launch({ dropPendingUpdates: true, allowedUpdates: ["message"] });

  bot.telegram.setMyCommands(commands.map(cmd => cmd.getTelegramCommandMenuEntry()), { scope: { type: "all_private_chats" } }); // Should be Typegram.BotCommandScopeAllPrivateChats or sth similar
  bot.telegram.setMyCommands(commands.filter(c => !c.isPrivate).map(cmd => cmd.getTelegramCommandMenuEntry()), { scope: { type: "all_group_chats" } });
}