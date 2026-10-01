# Spark — relative momentum continuation v1

Long-only Coinbase spot. Rank eligible products by completed-hour seven-day return.
Both seven-day and 24-hour returns must be positive, and the latest completed
15-minute close must exceed its preceding close. Assess strongest candidates for
continuation versus exhaustion, including liquidity and Laya classification.
BUY or SKIP when flat. SELL or HOLD when positioned, considering deteriorating
momentum. No automatic buying of the ranking leader and no forced daily trade.
One position per bot. Rotation requires selling first, then a fresh later assessment.
Configured rules determine size and protective exits.
