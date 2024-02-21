import { Number256, convertAlphAmountWithDecimals, prettifyAttoAlphAmount } from "@alephium/web3";
import { User } from "./db/user";

export enum ErrorTypes {
    NOT_ENOUGH_MONEY = "not enough money",
    UN_INITIALIZED_WALLET = "It seems that you haven't initialized your wallet yet. Send /start to do it!",
    USER_ALREADY_REGISTERED = "user already registered",
}

export function genUserMessageErrorWhile(action: string): string {
    return `An error occured while ${action}. Please try again later.`;
}

export function genLogMessageErrorWhile(action: string, err: Error | string, user?: User): string {
    return `failed to ${action} for ${user} (err: ${err})`
}

// From https://medium.com/with-orus/the-5-commandments-of-clean-error-handling-in-typescript-93a9cbdf1af5
type Jsonable = string | number | boolean | null | undefined | readonly Jsonable[] | { readonly [key: string]: Jsonable } | { toJSON(): Jsonable }
export class GeneralError extends Error {
  public readonly context?: Jsonable

  constructor(message: string, options: { error?: Error, context?: Jsonable } = {}) {
    const { error, context } = options;

    super(message, error );
    this.name = this.constructor.name;

    this.context = context;
  }
}

export function alphErrorIsNetworkError(value: Error): boolean {
  return (value instanceof Error) && "message" in value && value.message == "fetch failed";
}

export class NetworkError extends GeneralError {
  constructor(error?: Error) {
    super("network error", { error });
  }
}

const alphAPIErrorRegex = /^[API Error] - /;

export function alphErrorIsAPIError(err: Error): boolean {
  let args: RegExpMatchArray
  return (args = err.message.match(alphAPIErrorRegex)) && 1 == args.length;
}

export class AlphAPIError extends GeneralError {
  constructor(message: string, options: { error?: Error, context?: Jsonable } = {}) {
    super(message, options);
  }
}

const notEnoughFundsRegex = /^\[API Error\] - Not enough balance: got (\d+), expected (\d+)$/;

export function alphErrorIsNotEnoughFundsError(err: Error): boolean {
  if (!(err instanceof Error) || !("message" in err)) {
    console.error("Expected NotEnoughFundsError: instead got", err);
    return false;
  }
  let numbers: RegExpMatchArray;
  numbers = err.message.match(notEnoughFundsRegex);
  return 3 === numbers.length;
}

export class NotEnoughFundsError extends AlphAPIError {
  readonly actualFunds: Number256;
  readonly requiredFunds: Number256;

  constructor(error?: Error) {
    let args = error.message.match(notEnoughFundsRegex);    
    super("not enough funds error", {
      error,
      context: {
        actualFunds: args[1],
        requiredFunds: args[2],
      }
    });
    this.actualFunds = BigInt(args[1]);
    this.requiredFunds = BigInt(args[2]);
  }
}