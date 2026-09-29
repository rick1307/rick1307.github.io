/*
  Wild Ledger Community Registry.

  Every community is defined once here. Public-facing pages use the same
  registry as the Owner / Community Operator backend. The ?community= value
  selects the active public community when this script is loaded normally.

  Backend pages may load this script with data-registry-only="true" to use the
  registry and resolver helpers without changing the active public community.
*/
(() => {
  const communities = {
    sfl: {
      id: "sfl",
      backendId: "SFL",
      aliases: ["sailing-frogs-leap"],
      operatingWallet: "rfcDSPNx7ZtrPhs1bB7bzjcRdKVnRXCB9Q",
      directoryStatus: "Current Community",
      directoryTone: "current",
      directoryDescription: "The current working community and first live Wild Ledger implementation.",
      defaultPublic: true,
      layout: "classic",
      communityName: "Sailing Frog's Leap",
      leapNamespace: "SFL-LEAP",
      managerName: "Rick",
      operatorName: "Rick",
      operatorPossessive: "Rick's",
      membershipLabel: "Crew Membership",
      memberSingular: "Leaper",
      memberPlural: "Leapers",
      groupName: "crew",
      recordLabel: "Member Record",
      historyLabel: "crew history",
      joinLabel: "Join the Crew →",
      heading: "Welcome Aboard",
      intro: "Hello, my name is Rick, and I'm Sailing Frog's Leap. If you follow my Sailing Frog's Leap YouTube channel, you're already a Leaper. LEAP is how Leapers can come aboard and become part of the Sailing Frog's Leap crew.",
      bannerDesktop: "images/bannerDesktop.jpg",
      bannerMobile: "images/bannerMobile.jpg",
      profileImage: "images/profileImage.jpg",
      heroImage: "images/heroImage.jpg",
      eventHeroImage: "images/rickEventHero.jpg",
      experienceLine: "Earning LEAP follows a clear idea: come aboard, show up, and leave a wake.",
      experienceSteps: ["Come aboard", "Show up", "Leave a wake"],
      walletStorageKey: "sfl.xrpl.wallet",
      activeWalletKey: "sfl.xrpl.activeWallet",
      unrankedRankLabel: "Not aboard",
      ranks: [
        { min: 1, name: "Deckhand" },
        { min: 5, name: "Bosun" },
        { min: 10, name: "Quartermaster" },
        { min: 25, name: "First Mate" },
        { min: 51, name: "Master of the Leap" }
      ],
      badges: [
        {
          name: "Crew",
          type: "Standard badge",
          icon: "🛠️",
          description: "You showed up and helped in a real way — on the boat, with a project, with logistics, with local help, or wherever an extra hand mattered."
        },
        {
          name: "Shipmate",
          type: "Standard badge",
          icon: "⛵",
          description: "You were actually aboard Frog's Leap. It marks a real connection to the boat and a shared piece of the Sailing Frog's Leap story."
        },
        {
          name: "First Wake",
          type: "Standard badge",
          icon: "🌊",
          description: "Your first meaningful contribution after joining — helping someone, contributing something useful, participating in a real way, or otherwise leaving a wake."
        },
        {
          name: "LEAP OG",
          type: "Limited badge",
          icon: "🐸",
          description: "You were part of LEAP at the beginning. Unlike the standard badges, LEAP OG belongs only to the original early crew."
        }
      ],
      theme: {
        paper: "#efe8d8",
        paper2: "#f8f3e8",
        ink: "#17313a",
        navy: "#123b46",
        deep: "#0b2d36",
        sea: "#2f7481",
        foam: "#d7ebe7",
        rust: "#b85a40",
        gold: "#d7ae62",
        line: "rgba(15,52,64,.16)",
        card: "rgba(250,252,247,.80)",
        muted: "#526a70",
        pageBackground: "radial-gradient(circle at 12% -8%,rgba(215,174,98,.22),transparent 29%), radial-gradient(circle at 88% 4%,rgba(47,116,129,.22),transparent 31%), linear-gradient(180deg,#eee8dc 0%,#e2ebe6 24%,#d3e3df 56%,#bfd6d4 100%)",
        pageOverlay: "repeating-radial-gradient(ellipse at 18% 32%,transparent 0 30px,rgba(18,59,70,.045) 31px 32px,transparent 33px 64px), repeating-radial-gradient(ellipse at 82% 70%,transparent 0 40px,rgba(255,255,255,.18) 41px 42px,transparent 43px 80px)",
        navBackground: "rgba(226,235,230,.88)",
        headerBackground: "linear-gradient(180deg,rgba(239,232,216,.68),rgba(229,239,234,.18) 78%,transparent)",
        sectionBackground: "linear-gradient(180deg,rgba(255,255,255,.08),rgba(18,59,70,.018),rgba(255,255,255,.06))",
        manifestoBackground: "linear-gradient(135deg,#0b2d36,#184d58 68%,#235f69)",
        darkFeatureBackground: "linear-gradient(135deg,rgba(16,58,69,.95),rgba(37,96,106,.92))",
        badgeBackground: "linear-gradient(135deg,rgba(211,235,230,.94),rgba(235,243,236,.78))",
        portraitBackground: "rgba(250,252,247,.84)",
        themeColor: "#efe8d8"
      }
    },

    zach: {
      id: "zach",
      backendId: "ZHR",
      aliases: ["zhr", "zachs-hot-rods"],
      operatingWallet: null,
      directoryStatus: "Reference Community",
      directoryTone: "reference",
      directoryDescription: "A reference community used to prove that Wild Ledger's shared machinery is not tied to Sailing Frog's Leap.",
      layout: "garage",
      communityName: "Zach's Hot Rods",
      leapNamespace: "ZHR-LEAP",
      managerName: "Zach",
      operatorName: "Zach",
      operatorPossessive: "Zach's",
      membershipLabel: "Membership",
      memberSingular: "member",
      memberPlural: "members",
      groupName: "community",
      recordLabel: "Member Record",
      historyLabel: "community history",
      joinLabel: "Join →",
      heading: "Start Your Engines",
      intro: "Hey y'all. My name is Zach. If you follow me on Instagram or TikTok, you already know we're in for a good time. Show me your LEAP, climb in. Let's go for a ride!",
      bannerDesktop: "images/zachBannerDesktop.jpg",
      bannerMobile: "images/zachBannerMobile.jpg",
      profileImage: "images/zachProfileImage.jpg",
      heroImage: "images/zachHeroImage.jpg",
      eventHeroImage: "images/zachEventHero.jpg",
      experienceLine: "Show up. Get your hands dirty. Leave inspired.",
      experienceSteps: ["Show up", "Get your hands dirty", "Leave inspired"],
      walletStorageKey: "zach.xrpl.wallet",
      activeWalletKey: "zach.xrpl.activeWallet",
      unrankedRankLabel: "Not ranked",
      ranks: [
        { min: 1, name: "Lug Nut" },
        { min: 5, name: "Grease Monkey" },
        { min: 10, name: "Gearhead" },
        { min: 25, name: "Crew Chief" },
        { min: 51, name: "Shop Legend" }
      ],
      badges: [],
      theme: {
        paper: "#e7dfd2",
        paper2: "#f3ece2",
        ink: "#2c2926",
        navy: "#3a2923",
        deep: "#241a17",
        sea: "#746458",
        foam: "#eadfce",
        rust: "#a33a2c",
        gold: "#c79a56",
        line: "rgba(58,41,35,.19)",
        card: "rgba(248,242,233,.84)",
        muted: "#665a52",
        pageBackground: "radial-gradient(circle at 10% -8%,rgba(163,58,44,.22),transparent 28%), radial-gradient(circle at 90% 2%,rgba(199,154,86,.22),transparent 30%), linear-gradient(180deg,#e3d8ca 0%,#d7cbbb 24%,#c9bbaa 56%,#b4a18d 100%)",
        pageOverlay: "repeating-linear-gradient(115deg,transparent 0 34px,rgba(58,41,35,.035) 35px 36px,transparent 37px 70px), repeating-radial-gradient(ellipse at 78% 68%,transparent 0 46px,rgba(255,255,255,.13) 47px 48px,transparent 49px 92px)",
        navBackground: "rgba(226,214,200,.91)",
        headerBackground: "linear-gradient(180deg,rgba(234,223,209,.74),rgba(213,198,181,.20) 78%,transparent)",
        sectionBackground: "linear-gradient(180deg,rgba(255,255,255,.07),rgba(58,41,35,.025),rgba(255,255,255,.05))",
        manifestoBackground: "linear-gradient(135deg,#241a17,#4d2b25 68%,#6d382c)",
        darkFeatureBackground: "linear-gradient(135deg,rgba(52,31,27,.97),rgba(107,54,43,.94))",
        badgeBackground: "linear-gradient(135deg,rgba(235,219,197,.96),rgba(245,235,221,.82))",
        portraitBackground: "rgba(248,242,233,.88)",
        themeColor: "#e7dfd2"
      }
    }
  };

  const aliasToId = new Map();

  Object.values(communities).forEach((community) => {
    const aliases = [
      community.id,
      community.backendId,
      ...(Array.isArray(community.aliases) ? community.aliases : [])
    ];

    aliases.forEach((value) => {
      const key = String(value || "").trim().toLowerCase();
      if (key) aliasToId.set(key, community.id);
    });
  });

  function resolveCommunityId(value) {
    const key = String(value || "").trim().toLowerCase();
    return aliasToId.get(key) || "";
  }

  function getCommunity(value) {
    const id = resolveCommunityId(value);
    return id ? communities[id] : null;
  }

  function getBackendCommunityId(value) {
    const community = typeof value === "object" && value
      ? value
      : getCommunity(value);
    return community?.backendId || community?.id?.toUpperCase?.() || "";
  }

  // The registry is the one shared source of community truth.
  window.WILD_LEDGER_COMMUNITY_REGISTRY = communities;
  window.WILD_LEDGER_COMMUNITIES = communities; // Backward-compatible name used by setup.html.
  window.WILD_LEDGER_RESOLVE_COMMUNITY_ID = resolveCommunityId;
  window.WILD_LEDGER_GET_COMMUNITY = getCommunity;
  window.WILD_LEDGER_BACKEND_COMMUNITY_ID = getBackendCommunityId;

  const registryOnly = document.currentScript?.dataset?.registryOnly === "true";
  if (registryOnly) return;

  const ACTIVE_COMMUNITY_KEY = "wildLedger.activeCommunity";
  const params = new URLSearchParams(window.location.search);
  const requestedFromUrl = resolveCommunityId(params.get("community"));

  let requestedFromReferrer = "";
  try {
    if (document.referrer) {
      const referrerUrl = new URL(document.referrer);
      if (referrerUrl.origin === window.location.origin) {
        requestedFromReferrer = resolveCommunityId(referrerUrl.searchParams.get("community"));
      }
    }
  } catch (_) {}

  let rememberedCommunity = "";
  try {
    rememberedCommunity = resolveCommunityId(sessionStorage.getItem(ACTIVE_COMMUNITY_KEY));
  } catch (_) {}

  const defaultCommunityId =
    Object.values(communities).find((community) => community.defaultPublic)?.id ||
    Object.keys(communities)[0] ||
    "";

  const communityId =
    requestedFromUrl ||
    requestedFromReferrer ||
    rememberedCommunity ||
    defaultCommunityId;

  try {
    sessionStorage.setItem(ACTIVE_COMMUNITY_KEY, communityId);
  } catch (_) {}

  window.WILD_LEDGER_COMMUNITY_ID = communityId;
  window.WILD_LEDGER_COMMUNITY = communities[communityId];
})();
