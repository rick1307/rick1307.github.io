/*
  Wild Ledger presentation catalog.

  CONFIG schema is the stable data contract. Layouts and skins are curated
  presentation packages selected inside that contract. Store ownership/unlocks
  are a separate concern and are intentionally not represented here.

  Working reference packages:
    SFL -> layout-1 + skin-1
    ZHR -> layout-2 + skin-2

  Names are intentionally plain while the product naming is still being worked
  out. Operators choose packages; they do not edit the raw CSS values directly.
*/

export const WILD_LEDGER_LAYOUTS = Object.freeze({
  "layout-1": Object.freeze({
    id: "layout-1",
    code: 1,
    label: "Layout 1",
    referenceCommunityId: "SFL",
    referenceLabel: "Sailing Frog's Leap",
    description: "The current Sailing Frog's Leap information structure.",
    included: true,
    previewClass: "layout-one"
  }),
  "layout-2": Object.freeze({
    id: "layout-2",
    code: 2,
    label: "Layout 2",
    referenceCommunityId: "ZHR",
    referenceLabel: "Zach's Hot Rods",
    description: "The current Zach's Hot Rods information structure.",
    included: true,
    previewClass: "layout-two"
  })
});

export const WILD_LEDGER_SKINS = Object.freeze({
  "skin-1": Object.freeze({
    id: "skin-1",
    code: 1,
    label: "Skin 1",
    referenceCommunityId: "SFL",
    referenceLabel: "Sailing Frog's Leap",
    compatibleLayouts: Object.freeze(["layout-1"]),
    included: true,
    preview: Object.freeze({
      background: "linear-gradient(145deg,#efe8d8 0%,#d7e7e2 62%,#bfd6d4 100%)",
      panel: "rgba(250,252,247,.84)",
      ink: "#17313a",
      muted: "#526a70",
      accent: "#b85a40",
      secondary: "#2f7481",
      line: "rgba(15,52,64,.16)",
      font: "ui-serif, Georgia, Cambria, 'Times New Roman', serif"
    })
  }),
  "skin-2": Object.freeze({
    id: "skin-2",
    code: 2,
    label: "Skin 2",
    referenceCommunityId: "ZHR",
    referenceLabel: "Zach's Hot Rods",
    compatibleLayouts: Object.freeze(["layout-2"]),
    included: true,
    preview: Object.freeze({
      background: "linear-gradient(145deg,#e7dfd2 0%,#cfbfac 58%,#b4a18d 100%)",
      panel: "rgba(248,242,233,.88)",
      ink: "#2c2926",
      muted: "#665a52",
      accent: "#a33a2c",
      secondary: "#746458",
      line: "rgba(58,41,35,.19)",
      font: "ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
    })
  })
});

export function presentationSelection(layoutId, skinId) {
  const layout = WILD_LEDGER_LAYOUTS[String(layoutId || "").trim()] || null;
  const skin = WILD_LEDGER_SKINS[String(skinId || "").trim()] || null;
  if (!layout) throw new Error(`Unknown Wild Ledger layout: ${layoutId || "(blank)"}.`);
  if (!skin) throw new Error(`Unknown Wild Ledger skin: ${skinId || "(blank)"}.`);
  if (!skin.compatibleLayouts.includes(layout.id)) {
    throw new Error(`${skin.id} is not compatible with ${layout.id}.`);
  }
  return { layout, skin };
}

export function availableLayouts() {
  return Object.values(WILD_LEDGER_LAYOUTS);
}

export function availableSkins(layoutId = "") {
  const id = String(layoutId || "").trim();
  return Object.values(WILD_LEDGER_SKINS).filter(skin => !id || skin.compatibleLayouts.includes(id));
}

export function defaultPresentationSelection() {
  return { layoutId: "layout-1", skinId: "skin-1" };
}

export function layoutCodeForId(layoutId) {
  const layout = WILD_LEDGER_LAYOUTS[String(layoutId || "").trim()] || null;
  if (!layout || !Number.isInteger(layout.code) || layout.code < 1) {
    throw new Error(`Unknown Wild Ledger layout code for ${layoutId || "(blank)"}.`);
  }
  return layout.code;
}

export function layoutIdForCode(code) {
  const number = Number(code);
  const layout = Object.values(WILD_LEDGER_LAYOUTS).find(item => item.code === number) || null;
  if (!layout) throw new Error(`Unknown Wild Ledger layout code: ${code}.`);
  return layout.id;
}

export function skinCodeForId(skinId) {
  const skin = WILD_LEDGER_SKINS[String(skinId || "").trim()] || null;
  if (!skin || !Number.isInteger(skin.code) || skin.code < 1) {
    throw new Error(`Unknown Wild Ledger skin code for ${skinId || "(blank)"}.`);
  }
  return skin.code;
}

export function skinIdForCode(code) {
  const number = Number(code);
  const skin = Object.values(WILD_LEDGER_SKINS).find(item => item.code === number) || null;
  if (!skin) throw new Error(`Unknown Wild Ledger skin code: ${code}.`);
  return skin.id;
}
