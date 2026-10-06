/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — backgrounds (mirrors shared/data/backgrounds.ts)
 *
 *  Only gradient presets are shipped: the video backgrounds this project once
 *  referenced (`/videos/bg-*.webm`) have no media files in the repository or in
 *  the deployed bundle, so they would render as broken/blank backgrounds. The
 *  `Background` component still supports video presets, so a future deployment
 *  that adds the actual video files can restore them here.
 *--------------------------------------------------------------------------------------------*/

export const backgrounds = [
  { label: "Gradient Night", value: "gradient-night" },
  { label: "Gradient Ember", value: "gradient-ember" },
  { label: "Gradient Steel", value: "gradient-steel" },
  { label: "Gradient Dust", value: "gradient-dust" }
];

export const backgroundValues = backgrounds.map(({ value }) => value);
