import { notify, parseWeight } from "./shipping";

/** `notify` is handed over as a value here, so its call shape cannot change. */
export const send: (address: string, message: string) => string = notify;

export const parsed = parseWeight("500", "g");
