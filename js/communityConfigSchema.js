/*
  Wild Ledger community CONFIG schema v1.

  Schema is the stable data contract. Curated layout/skin packages carry the
  presentation treatment; raw CSS/color controls do not belong in the community
  CONFIG itself.
*/

import { defaultPresentationSelection, presentationSelection } from "./presentationCatalog.js";

export const COMMUNITY_CONFIG_SCHEMA = 1;

const CONFIG_V1_KEYS = Object.freeze([
  "configSchema",
  "communityId",
  "leapNamespace",
  "layoutId",
  "skinId",
  "communityName",
  "managerName",
  "operatorName",
  "operatorPossessive",
  "membershipLabel",
  "memberSingular",
  "memberPlural",
  "groupName",
  "recordLabel",
  "historyLabel",
  "joinLabel",
  "heading",
  "intro",
  "experienceLine",
  "experienceSteps",
  "unrankedRankLabel",
  "rankNames",
  "rankThresholds"
]);

export function canonicalCommunityId(value) {
  const id = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]*$/.test(id)) throw new Error("Community ID is not canonical.");
  return id;
}

function ownKeysExact(object, expected, label) {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(object);
  const missing = expected.filter(key => !Object.prototype.hasOwnProperty.call(object, key));
  const extra = actual.filter(key => !expected.includes(key));
  if (missing.length || extra.length) {
    const detail = [
      missing.length ? `missing: ${missing.join(", ")}` : "",
      extra.length ? `extra: ${extra.join(", ")}` : ""
    ].filter(Boolean).join("; ");
    throw new Error(`${label} does not match CONFIG schema 1 (${detail}).`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function possessive(name) {
  const clean = String(name || "").trim();
  if (!clean) return "Operator's";
  return /s$/i.test(clean) ? `${clean}'` : `${clean}'s`;
}

export function buildCommunityConfigV1Preset({
  communityId,
  communityName = "",
  managerName = "",
  layoutId = "",
  skinId = ""
} = {}) {
  const id = canonicalCommunityId(communityId);
  const defaults = defaultPresentationSelection();
  const manager = String(managerName || "").trim();
  const name = String(communityName || "").trim();

  return {
    configSchema: COMMUNITY_CONFIG_SCHEMA,
    communityId: id,
    leapNamespace: `${id}-LEAP`,
    layoutId: layoutId || defaults.layoutId,
    skinId: skinId || defaults.skinId,
    communityName: name,
    managerName: manager,
    operatorName: manager,
    operatorPossessive: possessive(manager),
    membershipLabel: "Membership",
    memberSingular: "member",
    memberPlural: "members",
    groupName: "community",
    recordLabel: "Member Record",
    historyLabel: "community history",
    joinLabel: "Join →",
    heading: "Welcome",
    intro: "",
    experienceLine: "Show up. Participate. Build a history.",
    experienceSteps: ["Show up", "Participate", "Build a history"],
    unrankedRankLabel: "Not ranked",
    rankNames: ["Rank 1", "Rank 2", "Rank 3", "Rank 4", "Rank 5"],
    rankThresholds: [1, 5, 10, 25, 51]
  };
}

export function communityConfigV1FromLegacy(legacy, { communityId = "" } = {}) {
  if (!legacy || typeof legacy !== "object") throw new Error("Legacy community configuration is required.");
  const id = canonicalCommunityId(communityId || legacy.backendId || legacy.id);
  const layoutId = legacy.layout === "garage" ? "layout-2" : "layout-1";
  const skinId = layoutId === "layout-2" ? "skin-2" : "skin-1";
  const preset = buildCommunityConfigV1Preset({
    communityId: id,
    communityName: legacy.communityName || id,
    managerName: legacy.managerName || legacy.operatorName || "Operator",
    layoutId,
    skinId
  });

  const ranks = Array.isArray(legacy.ranks) ? legacy.ranks.slice(0, 5) : [];
  return normalizeCommunityConfigV1({
    ...preset,
    communityName: String(legacy.communityName || preset.communityName),
    managerName: String(legacy.managerName || preset.managerName),
    operatorName: String(legacy.operatorName || legacy.managerName || preset.operatorName),
    operatorPossessive: String(legacy.operatorPossessive || possessive(legacy.operatorName || legacy.managerName)),
    membershipLabel: String(legacy.membershipLabel || preset.membershipLabel),
    memberSingular: String(legacy.memberSingular || preset.memberSingular),
    memberPlural: String(legacy.memberPlural || preset.memberPlural),
    groupName: String(legacy.groupName || preset.groupName),
    recordLabel: String(legacy.recordLabel || preset.recordLabel),
    historyLabel: String(legacy.historyLabel || preset.historyLabel),
    joinLabel: String(legacy.joinLabel || preset.joinLabel),
    heading: String(legacy.heading || preset.heading),
    intro: String(legacy.intro || `Welcome to ${legacy.communityName || id}.`),
    experienceLine: String(legacy.experienceLine || preset.experienceLine),
    experienceSteps: Array.isArray(legacy.experienceSteps) && legacy.experienceSteps.length === 3
      ? legacy.experienceSteps.map(String)
      : [...preset.experienceSteps],
    unrankedRankLabel: String(legacy.unrankedRankLabel || preset.unrankedRankLabel),
    rankNames: ranks.length === 5 ? ranks.map(rank => String(rank?.name || "")) : [...preset.rankNames],
    rankThresholds: ranks.length === 5 ? ranks.map(rank => Number(rank?.min)) : [...preset.rankThresholds]
  }, { communityId: id });
}

export function normalizeCommunityConfigV1(config, { communityId = "" } = {}) {
  ownKeysExact(config, CONFIG_V1_KEYS, "CONFIG");

  if (Number(config.configSchema) !== COMMUNITY_CONFIG_SCHEMA) {
    throw new Error(`CONFIG schema must equal ${COMMUNITY_CONFIG_SCHEMA}.`);
  }

  const id = canonicalCommunityId(config.communityId);
  if (communityId && id !== canonicalCommunityId(communityId)) {
    throw new Error("CONFIG Community ID does not match the requested community.");
  }

  if (String(config.leapNamespace || "").trim().toUpperCase() !== `${id}-LEAP`) {
    throw new Error("CONFIG LEAP namespace does not match its Community ID.");
  }

  const stringKeys = [
    "layoutId", "skinId", "communityName", "managerName", "operatorName",
    "operatorPossessive", "membershipLabel", "memberSingular", "memberPlural",
    "groupName", "recordLabel", "historyLabel", "joinLabel", "heading", "intro",
    "experienceLine", "unrankedRankLabel"
  ];
  stringKeys.forEach(key => requireString(config[key], `CONFIG ${key}`));

  presentationSelection(config.layoutId, config.skinId);

  if (!Array.isArray(config.experienceSteps) || config.experienceSteps.length !== 3) {
    throw new Error("CONFIG experienceSteps must contain exactly three strings.");
  }
  config.experienceSteps.forEach((value, index) => requireString(value, `CONFIG experienceSteps[${index}]`));

  if (!Array.isArray(config.rankNames) || config.rankNames.length !== 5) {
    throw new Error("CONFIG rankNames must contain exactly five strings.");
  }
  config.rankNames.forEach((value, index) => requireString(value, `CONFIG rankNames[${index}]`));

  if (!Array.isArray(config.rankThresholds) || config.rankThresholds.length !== 5) {
    throw new Error("CONFIG rankThresholds must contain exactly five whole numbers.");
  }
  let prior = 0;
  config.rankThresholds.forEach((value, index) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number <= prior) {
      throw new Error(`CONFIG rankThresholds[${index}] must be a positive whole number greater than the previous threshold.`);
    }
    prior = number;
  });

  const normalized = {};
  for (const key of CONFIG_V1_KEYS) {
    if (key === "configSchema") normalized[key] = COMMUNITY_CONFIG_SCHEMA;
    else if (key === "communityId") normalized[key] = id;
    else if (key === "leapNamespace") normalized[key] = `${id}-LEAP`;
    else if (key === "experienceSteps" || key === "rankNames") normalized[key] = [...config[key]];
    else if (key === "rankThresholds") normalized[key] = config[key].map(Number);
    else normalized[key] = String(config[key]);
  }
  return normalized;
}

export function canonicalCommunityConfigText(config, options = {}) {
  return JSON.stringify(normalizeCommunityConfigV1(config, options));
}

export function communityConfigByteLength(config, options = {}) {
  return new TextEncoder().encode(canonicalCommunityConfigText(config, options)).length;
}
