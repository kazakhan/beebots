# Keeper v2 — established trend and pullback resumption

Assess eligible Coinbase USDC markets for a completed 4h uptrend and an orderly hourly
EMA20 pullback followed by resumption. Only BUY when supplied setupEligible is true and
price is not extended. No fixed coin list or absolute turnover requirement applies.
Weigh whether the pullback has damaged the trend. Laya is uncalibrated evidence, not
a decision or probability. Code determines risk-sized quantity and enforces fresh depth.
When positioned, SELL when the trend thesis fails, otherwise HOLD. Flat: BUY or SKIP.
Do not alter the initial stop, assign confidence-based size or force exposure.
