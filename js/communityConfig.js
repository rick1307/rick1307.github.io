/*
  Wild Ledger community configuration.
  One index.html; the ?community= value selects the community.
*/
(() => {
  const communities = {
    sfl: {
      id: "sfl",
      communityName: "Sailing Frog's Leap",
      managerName: "Rick",
      membershipLabel: "Crew Membership",
      memberSingular: "Leaper",
      memberPlural: "Leapers",
      groupName: "crew",
      recordLabel: "Crew Record",
      historyLabel: "crew history",
      joinLabel: "Join the Crew →",
      heading: "Welcome Aboard",
      intro: "Hello, my name is Rick, and I'm Sailing Frog's Leap. If you follow my Sailing Frog's Leap YouTube channel, you're already a Leaper. LEAP is how Leapers can come aboard and become part of the Sailing Frog's Leap crew.",
      bannerDesktop: "images/bannerDesktop.png",
      bannerMobile: "images/bannerMobile.png",
      profileImage: "images/profileImage.png",
      heroImage: "images/heroImage.png",
      experienceLine: "Earning LEAP follows a clear idea: come aboard, show up, and leave a wake.",
      experienceSteps: ["Come aboard", "Show up", "Leave a wake"],
      walletStorageKey: "sfl.xrpl.wallet",
      activeWalletKey: "sfl.xrpl.activeWallet"
    },

    zach: {
      id: "zach",
      communityName: "Zach's Hot Rods",
      managerName: "Zach",
      membershipLabel: "Membership",
      memberSingular: "member",
      memberPlural: "members",
      groupName: "community",
      recordLabel: "Member Record",
      historyLabel: "community history",
      joinLabel: "Join →",
      heading: "Start Your Engines",
      intro: "Hey y'all. My name is Zach. If you follow me on Instagram or TikTok, you already know we're in for a good time. Show me your LEAP, climb in. Let's go for a ride!",
      bannerDesktop: "images/zachBannerDesktop.png",
      bannerMobile: "images/zachBannerMobile.png",
      profileImage: "images/zachProfileImage.png",
      heroImage: "images/zachHeroImage.png",
      experienceLine: "Show up. Get your hands dirty. Leave inspired.",
      experienceSteps: ["Show up", "Get your hands dirty", "Leave inspired"],
      walletStorageKey: "zach.xrpl.wallet",
      activeWalletKey: "zach.xrpl.activeWallet"
    }
  };

  const params = new URLSearchParams(window.location.search);
  const requestedId = (params.get("community") || "sfl").toLowerCase();
  const communityId = communities[requestedId] ? requestedId : "sfl";

  window.WILD_LEDGER_COMMUNITIES = communities;
  window.WILD_LEDGER_COMMUNITY_ID = communityId;
  window.WILD_LEDGER_COMMUNITY = communities[communityId];
})();
