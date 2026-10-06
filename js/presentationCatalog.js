/*
  Wild Ledger presentation catalog.

  CONFIG schema is the data contract. Layouts and skins are curated presentation
  packages selected inside that contract. Store ownership/unlocks are a separate
  concern and are intentionally not represented here.

  Working reference packages:
    SFL -> layout-1 + skin-1
    ZHR -> layout-2 + skin-2
*/

export const WILD_LEDGER_LAYOUTS = Object.freeze({
  "layout-1": Object.freeze({
    id: "layout-1",
    referenceCommunityId: "SFL",
    included: true
  }),
  "layout-2": Object.freeze({
    id: "layout-2",
    referenceCommunityId: "ZHR",
    included: true
  })
});

export const WILD_LEDGER_SKINS = Object.freeze({
  "skin-1": Object.freeze({
    id: "skin-1",
    referenceCommunityId: "SFL",
    compatibleLayouts: Object.freeze(["layout-1"]),
    included: true
  }),
  "skin-2": Object.freeze({
    id: "skin-2",
    referenceCommunityId: "ZHR",
    compatibleLayouts: Object.freeze(["layout-2"]),
    included: true
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
