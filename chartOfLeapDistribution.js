(() => {
  "use strict";

  // Illustrative only. This array is the single data source for every view.
  // Later, the same shape can be populated from validated SFL-LEAP/SNAPSHOT records.
  const SAMPLE_HISTORY = [
    { label: "Day 1",  crew: 0,  holders: 0 },
    { label: "Day 7",  crew: 3,  holders: 5 },
    { label: "Day 14", crew: 7,  holders: 13 },
    { label: "Day 21", crew: 13, holders: 23 },
    { label: "Day 28", crew: 21, holders: 37 },
    { label: "Day 35", crew: 29, holders: 52 },
    { label: "Day 42", crew: 38, holders: 70 },
    { label: "Day 49", crew: 47, holders: 90 }
  ];

  const VIEW_CONFIG = {
    crew: {
      title: "How is the organized crew growing?",
      subtitle: "A historical view of wallets recognized as organized LEAP crew over time.",
      series: ["crew"],
      note: "Illustrative values only. This view isolates organized-community growth while using the same underlying snapshot history as every other view.",
      questionOneTitle: "What would this tell us?",
      questionOneText: "This isolates growth of the organized LEAP community: how quickly new crew are joining and whether growth is steady or episodic.",
      questionTwoTitle: "Why keep it in the same chart engine?",
      questionTwoText: "Crew is not a separate dataset. It is one field in the same snapshots that also contain holder count, so a separate HTML page would duplicate presentation logic."
    },
    holders: {
      title: "How far is LEAP traveling?",
      subtitle: "A historical view of all wallets currently possessing LEAP.",
      series: ["holders"],
      note: "Illustrative values only. This view isolates holder growth while using the same underlying snapshot history as every other view.",
      questionOneTitle: "What would this tell us?",
      questionOneText: "This shows how widely LEAP possession is spreading, including wallets that may never have joined the organized crew.",
      questionTwoTitle: "What makes it useful?",
      questionTwoText: "Holder growth becomes especially meaningful when compared with crew growth. The raw count is an observation; the relationship between counts is interpretation."
    },
    compare: {
      title: "How are crew and holders moving together?",
      subtitle: "The two stored observations superimposed so their relationship can be seen directly.",
      series: ["holders", "crew"],
      note: "Illustrative values only. Both lines come from the same two snapshot fields: C for crew and H for holders.",
      questionOneTitle: "What would this tell us?",
      questionOneText: "If holders rise faster than crew, LEAP is spreading beyond the organized community. If the lines stay close, possession remains concentrated around crew.",
      questionTwoTitle: "Why is this efficient?",
      questionTwoText: "Nothing new has to be stored for the comparison. It is simply another presentation of the same C and H observations."
    },
    reach: {
      title: "How is LEAP Reach changing?",
      subtitle: "A derived historical relationship: total holders divided by total crew members.",
      series: ["reach"],
      note: "Illustrative values only. Reach is calculated from H ÷ C at render time and therefore does not need its own snapshot field.",
      questionOneTitle: "What would this tell us?",
      questionOneText: "Reach describes the relationship between organized participation and organic distribution. A rising number means holders are growing faster than crew.",
      questionTwoTitle: "Why not store Reach?",
      questionTwoText: "Because it can always be recreated from Crew and Holders. The snapshot stores observations; the chart derives relationships."
    }
  };

  const SERIES_META = {
    crew: { label: "Total crew members", className: "crew", dotClass: "dot-crew" },
    holders: { label: "Total LEAP holders", className: "holders", dotClass: "dot-holders" },
    reach: { label: "LEAP Reach", className: "reach", dotClass: "dot-reach" }
  };

  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = document.getElementById("chartSvg");
  const gridLayer = document.getElementById("gridLayer");
  const xLabels = document.getElementById("xLabels");
  const chartTitle = document.getElementById("chartTitle");
  const chartSubtitle = document.getElementById("chartSubtitle");
  const chartLegend = document.getElementById("chartLegend");
  const plotWrap = document.getElementById("plotWrap");
  const notionalNote = document.getElementById("notionalNote");
  const questionOneTitle = document.getElementById("questionOneTitle");
  const questionOneText = document.getElementById("questionOneText");
  const questionTwoTitle = document.getElementById("questionTwoTitle");
  const questionTwoText = document.getElementById("questionTwoText");
  const viewButtons = Array.from(document.querySelectorAll("[data-view]"));

  function reachFor(row) {
    return row.crew > 0 ? row.holders / row.crew : null;
  }

  function valuesFor(seriesName) {
    if (seriesName === "reach") {
      return SAMPLE_HISTORY.map(reachFor).filter(value => Number.isFinite(value));
    }
    return SAMPLE_HISTORY.map(row => row[seriesName]);
  }

  function niceScaleMax(seriesNames) {
    const values = seriesNames.flatMap(valuesFor);
    const rawMax = Math.max(...values, 1);

    if (seriesNames.length === 1 && seriesNames[0] === "reach") {
      return Math.max(2, Math.ceil(rawMax * 4) / 4);
    }

    if (rawMax <= 10) return Math.ceil(rawMax / 2) * 2;
    if (rawMax <= 50) return Math.ceil(rawMax / 10) * 10;
    if (rawMax <= 100) return Math.ceil(rawMax / 25) * 25;
    return Math.ceil(rawMax / 50) * 50;
  }

  function formatTick(value, reachMode) {
    if (reachMode) return `${Number(value.toFixed(2))}×`;
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
  }

  function buildGrid(maxValue, reachMode) {
    gridLayer.textContent = "";
    const intervals = 4;

    for (let i = 0; i <= intervals; i += 1) {
      const line = document.createElement("div");
      line.className = "gridline";
      line.style.bottom = `${40 + (272 / intervals) * i}px`;

      const label = document.createElement("span");
      label.textContent = formatTick((maxValue / intervals) * i, reachMode);
      line.appendChild(label);
      gridLayer.appendChild(line);
    }
  }

  function pointFor(index, value, maxValue) {
    const lastIndex = Math.max(1, SAMPLE_HISTORY.length - 1);
    const x = (700 / lastIndex) * index;
    const bounded = Math.max(0, Math.min(maxValue, value));
    const y = 272 - (bounded / maxValue) * 244;
    return { x, y };
  }

  function renderSeries(seriesName, maxValue, isSecondary) {
    const meta = SERIES_META[seriesName];
    const validPoints = [];

    SAMPLE_HISTORY.forEach((row, index) => {
      const value = seriesName === "reach" ? reachFor(row) : row[seriesName];
      if (!Number.isFinite(value)) return;
      const point = pointFor(index, value, maxValue);
      validPoints.push({ ...point, index });
    });

    const line = document.createElementNS(SVG_NS, "polyline");
    line.setAttribute("points", validPoints.map(point => `${point.x},${point.y}`).join(" "));
    line.setAttribute("class", `series-line ${meta.className}${isSecondary ? " secondary" : ""}`);
    svg.appendChild(line);

    validPoints.forEach(point => {
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", String(point.x));
      circle.setAttribute("cy", String(point.y));
      circle.setAttribute("r", seriesName === "crew" && isSecondary ? "4" : "5");
      circle.setAttribute("class", meta.dotClass);
      svg.appendChild(circle);
    });
  }

  function buildLegend(seriesNames) {
    chartLegend.textContent = "";
    seriesNames.forEach(seriesName => {
      const meta = SERIES_META[seriesName];
      const item = document.createElement("span");
      item.className = meta.className;
      const swatch = document.createElement("i");
      const label = document.createTextNode(meta.label);
      item.appendChild(swatch);
      item.appendChild(label);
      chartLegend.appendChild(item);
    });
  }

  function buildXLabels() {
    xLabels.textContent = "";
    xLabels.style.gridTemplateColumns = `repeat(${SAMPLE_HISTORY.length},1fr)`;
    SAMPLE_HISTORY.forEach(row => {
      const span = document.createElement("span");
      span.textContent = row.label;
      xLabels.appendChild(span);
    });
  }

  function normalizeView(value) {
    return Object.prototype.hasOwnProperty.call(VIEW_CONFIG, value) ? value : "compare";
  }

  function render(viewName, updateUrl = false) {
    const view = normalizeView(viewName);
    const config = VIEW_CONFIG[view];
    const reachMode = config.series.length === 1 && config.series[0] === "reach";
    const maxValue = niceScaleMax(config.series);

    chartTitle.textContent = config.title;
    chartSubtitle.textContent = config.subtitle;
    notionalNote.textContent = config.note;
    questionOneTitle.textContent = config.questionOneTitle;
    questionOneText.textContent = config.questionOneText;
    questionTwoTitle.textContent = config.questionTwoTitle;
    questionTwoText.textContent = config.questionTwoText;

    viewButtons.forEach(button => {
      button.setAttribute("aria-pressed", button.dataset.view === view ? "true" : "false");
    });

    buildLegend(config.series);
    buildGrid(maxValue, reachMode);
    buildXLabels();

    svg.textContent = "";
    config.series.forEach((seriesName, index) => renderSeries(seriesName, maxValue, index > 0));

    const seriesDescription = config.series.map(name => SERIES_META[name].label).join(" and ");
    plotWrap.setAttribute("aria-label", `Illustrative line chart for ${seriesDescription} across eight sample dates.`);

    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set("view", view);
      window.history.replaceState({}, "", url);
    }
  }

  viewButtons.forEach(button => {
    button.addEventListener("click", () => render(button.dataset.view, true));
  });

  const initialView = normalizeView(new URLSearchParams(window.location.search).get("view"));
  render(initialView);
})();
