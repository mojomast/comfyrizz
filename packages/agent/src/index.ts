export { routeAsset, routeBrief } from './router.js';
export type { AssetNeed, AssetRoute, RouteDecision } from './router.js';
export { expandFluxCaption, expandReferenceEditCaption, expandVideoCaption, aspectFromSize, sourceDims } from './caption.js';
export type { CaptionInput, ReferenceEditCaptionInput, VideoCaptionInput, Aspect } from './caption.js';
export { svgPipeline } from './svg.js';
export type { AutoFixLike, SvgFixResult, SvgGeneratorLike, SvgIntentLike } from './svg.js';
export {
  createToolset,
  proposeSchema,
  editSchema,
  routeSchema,
  generateSvgSchema,
  generateImageSchema,
  sketchToRenderSchema,
  cutdownSchema,
} from './tools.js';
export {
  CUTDOWN_SECONDS,
  cutdownPackage,
  fitNarration,
  isCutdownSeconds,
  pickCutdownScenes,
  stubVoice,
  targetFramesForSeconds,
} from './cutdown.js';
export type { CutdownResult, CutdownSeconds, PresenterPlan, VoiceFn, VoiceInput, VoiceResult } from './cutdown.js';
export type { AgentTool, PlannedImage, SvgAssetResult, ToolsetOptions } from './tools.js';
export { runAgent } from './agent.js';
export { runCpuSlice, defaultCpuScript } from './cpu-slice.js';
export type { CpuSliceOptions, CpuSliceResult } from './cpu-slice.js';
export { createScriptedModel } from './scripted-model.js';
export type { ScriptedCall } from './scripted-model.js';
export { DEFAULT_PALETTE, defaultCpuDatasets, defaultCpuScenes, foregroundFor, titleFor } from './package.js';
export {
  BRIEF_GOALS,
  BRIEF_MODES,
  BRIEF_LANGUAGES,
  BRIEF_ASPECTS,
  STYLE_PRESETS,
  STYLE_PRESET_DEFAULTS,
  BRIEF_EXAMPLE_PROMPTS,
  QUESTION_BANK,
  briefSchema,
  extractBrief,
  draftKeyMessages,
  missingQuestions,
  applyDecisions,
  completeBrief,
  secondsPerWord,
  estimateNarrationSeconds,
  buildOutline,
} from './brief.js';
export type { Brief, BriefDraft, Question, BriefDecisions, StylePreset, ExtractBriefOptions, Outline, OutlineBeat, OutlineOptions } from './brief.js';
export { stylePresets, STYLE_PRESET_LABELS } from './style-presets.js';
export type { StylePresetCard } from './style-presets.js';
export {
  BRAND_FALLBACK_FONT,
  BRAND_MAX_PALETTE,
  BRAND_MAX_FONTS,
  BRAND_MAX_TONE,
  BRAND_SAFE_FONT_LICENSES,
  brandFontSchema,
  brandKitSchema,
  isSafeFontLicense,
  effectiveFont,
  normalizeBrandKit,
  brandTheme,
  applyBrandKit,
  brandBriefStyle,
  brandStyleBlock,
} from './brand.js';
export type { BrandFont, BrandKit, BrandKitInput, BrandTheme, BrandWarning } from './brand.js';
export {
  SUPPORTED_LANGUAGES,
  LANGUAGE_LABELS,
  LANGUAGE_TAGS,
  VOICE_LANGUAGES,
  translatableStrings,
  variantPackageId,
  dictionaryTranslator,
  translateStrings,
  translationPrompt,
  applyLanguageVariant,
} from './language.js';
export type { SupportedLanguage, TranslatableString, SceneTranslation, LanguageVariantOptions } from './language.js';
export { SCENE_CHIPS, applySceneChip, isSceneChip, sceneChip, sceneChipList, warmHex } from './scene-chips.js';
export type { SceneChip, SceneChipResult, ChipPackage, ChipScene } from './scene-chips.js';
export {
  DATASET_MAX_VALUES,
  DATASET_MAX_LABEL,
  parseCsv,
  parseCsvNumber,
  datasetFromCsv,
  validateDataset,
  datasetValues,
  datasetHeadline,
} from './dataset.js';
export type { Dataset, DatasetValue, DatasetParseOptions, DatasetParseResult, CsvParseResult } from './dataset.js';
export { CHART_SCENE_KINDS, formatValue, sourceCaption, proposeChartScenes, proposalValues } from './chart-scenes.js';
export type { ChartSceneKind, ChartSceneProposal, ProposeChartScenesOptions } from './chart-scenes.js';
export type { AgentEvent, RunAgentOptions, RunAgentResult, ToolRecord } from './agent.js';
export {
  STYLE_PRESET_ENERGY,
  MOTION_CRITIQUE_FIX_AT_OR_BELOW,
  MOTION_CRITIQUE_LEAVE_AT_OR_ABOVE,
  MOTION_CRITIQUE_MAX_ROUNDS,
  motionVocabulary,
  motionSystemSection,
  lintPackageMotion,
  motionFixInstructions,
  normalizeSceneMotion,
  normalizePackageMotion,
  normalizeTransitionOut,
  providerDeclaresImageInput,
  critiqueRubricPrompt,
  parseCritiqueReply,
  runMotionCritique,
} from './prompts/motion.js';
export type {
  MotionVocabulary,
  MotionLintFinding,
  MotionFixInstruction,
  CritiqueSceneInput,
  CritiqueSceneScore,
  CritiqueRubric,
  MotionCritiqueResult,
  ImageInputDeclaration,
} from './prompts/motion.js';
export type { ChatChunk, ChatMessage, ChatModel, ChatRequest, ImagePart, ToolCall, ToolDef } from './types.js';
export {
  PRESENTER_COVERAGES,
  PRESENTER_PRESETS,
  PRESENTER_PLACEMENTS,
  PRESENTER_SHAPES,
  PRESENTER_SCENE_VALUES,
  PRESENTER_LABEL_DEFAULT,
  PRESENTER_SIZE_DEFAULT,
  PRESENTER_SIZE_MIN,
  PRESENTER_SIZE_MAX,
  presenterChips,
  presenterPresets,
  presenterPortraitPrompt,
  presenterSystemSection,
  coveredSceneIds,
  sceneShowsPresenter,
  lintPresenter,
  applyPresenterCoverage,
  applyPresenterScene,
  applyPresenterPreset,
  applyPresenterSet,
} from './presenter.js';
export type {
  PresenterCoverage,
  PresenterPreset,
  PresenterPlacement,
  PresenterShape,
  PresenterSceneValue,
  PresenterScene,
  PresenterBlock,
  PresenterPackage,
  PresenterSetArgs,
  PresenterSetResult,
  PresenterFinding,
} from './presenter.js';
