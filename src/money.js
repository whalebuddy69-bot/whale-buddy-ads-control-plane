const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"
]);

export function currencyFactor(currency) {
  return ZERO_DECIMAL_CURRENCIES.has(String(currency).toUpperCase()) ? 1 : 100;
}

export function toMinor(amount, currency) {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) throw new Error("amount must be a non-negative number");
  const scaled = amount * currencyFactor(currency);
  const value = Math.round(scaled);
  if (Math.abs(scaled - value) > 1e-8) throw new Error("amount has more precision than the currency supports");
  if (!Number.isSafeInteger(value)) throw new Error("amount is outside the safe integer range");
  return value;
}

export function fromMinor(amountMinor, currency) {
  if (!Number.isSafeInteger(amountMinor)) throw new Error("minor amount must be a safe integer");
  return amountMinor / currencyFactor(currency);
}
