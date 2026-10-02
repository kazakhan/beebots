// Pre-authored analysis-question variants.
//
// A System One model (Laya/Jev) cannot write text, so when no LLM is enabled it
// can only *select* among these ready-made `regime`/`fit`/`quality` question
// sets. The LLM, when enabled, may still author brand-new text beyond them. The
// heads and answer types are fixed - only the wording and criteria differ - so
// the response schema stays checkable.
const REGIME = {
  type: "choice",
  instructions: "Classify the observed price context, not a trading action.",
  criteria: {
    uptrend: "Sustained upward trend",
    range: "Sideways range",
    downtrend: "Downward trend",
    unclear: "Insufficient or conflicting evidence",
  },
};
const QUALITY = {
  type: "choice",
  instructions: "Classify the supplied evidence quality.",
  criteria: {
    complete: "Complete and consistent",
    mixed: "Conflicting signals",
    insufficient: "Missing important evidence",
  },
};

const fit = (instruction, criteria = ["weak", "mixed", "strong"]) => ({
  type: "score",
  instructions: instruction,
  criteria,
});

export const ANALYSIS_VARIANTS = {
  balanced: {
    fit: (style) =>
      fit(
        `Classify evidence of a ${style} setup. Weigh trend, momentum, volume and ` +
          "volatility together. Do not choose a trade.",
      ),
  },
  strict: {
    fit: (style) =>
      fit(
        `Classify evidence of a ${style} setup strictly. "strong" requires a clean ` +
          "trend AND confirming volume AND a favourable entry; anything doubtful is " +
          "'mixed' or 'weak'. Do not choose a trade.",
      ),
  },
  loose: {
    fit: (style) =>
      fit(
        `Classify evidence of a ${style} setup generously: 'strong' whenever the ` +
          "setup is present and not clearly broken; reserve 'weak' for a clear " +
          "absence of the setup. Do not choose a trade.",
      ),
  },
  trend_focus: {
    fit: (style) =>
      fit(
        `Classify evidence of a ${style} setup by its trend structure above all: ` +
          "higher-highs/higher-lows, EMA stacking and orderly pullbacks. " +
          "De-emphasise volume. Do not choose a trade.",
      ),
    quality: {
      type: "choice",
      instructions:
        "Classify the completeness of the trend evidence supplied (structure, " +
        "moving averages, higher timeframe context).",
      criteria: QUALITY.criteria,
    },
  },
  momentum_focus: {
    fit: (style) =>
      fit(
        `Classify evidence of a ${style} setup by relative strength and momentum ` +
          "persistence across horizons. Do not choose a trade.",
      ),
  },
  breakout_focus: {
    fit: (style) =>
      fit(
        `Classify evidence of a ${style} setup by range compression followed by ` +
          "expansion, judged with relative volume. Do not choose a trade.",
      ),
  },
};

export const VARIANT_NAMES = Object.keys(ANALYSIS_VARIANTS);

export function isVariant(name) {
  return typeof name === "string" && Object.hasOwn(ANALYSIS_VARIANTS, name);
}

// A complete question set for the named variant (defaulting to balanced).
export function variantQuestions(style, name) {
  const v = ANALYSIS_VARIANTS[name] ?? ANALYSIS_VARIANTS.balanced;
  const f = typeof v.fit === "function" ? v.fit(style) : v.fit;
  return {
    regime: { ...REGIME, ...(v.regime ?? {}) },
    fit: { ...f },
    quality: { ...QUALITY, ...(v.quality ?? {}) },
  };
}
