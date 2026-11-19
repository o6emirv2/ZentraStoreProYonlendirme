/* PlayMatrix clean: real home orchestrator. Each imported module owns one UI responsibility; legacy runtime remains the compatibility layer until later phases remove the final monolith. */
import { reportHomeError } from "/public-js-home-dom-utils.js";
import { installHomeWidgetContract } from "/public-js-home-widget-contract.js";
import { installGameRouteNormalizer } from "/public-js-home-game-catalog.js";
import { installAuthModalGuards } from "/public-js-home-auth-modal.js";
import { installProfilePanelGuards } from "/public-js-home-profile-panel.js";
import { installLeaderboardGuards } from "/public-js-home-leaderboard.js";
import { installStatsGuards } from "/public-js-home-stats.js";
import { installSocialEntryGuards } from "/public-js-home-social-entry.js";
import { installHeroSliderGuards } from "/public-js-home-hero-slider.js";
import { installModalSafety } from "/public-js-home-modal.js";
import { installRewardUiGuards } from "/public-js-home-reward-ui.js";
import { installInviteUiGuards } from "/public-js-home-invite-ui.js";
import "/public-js-home-legacy-home.runtime.js";
import { installSiteContent } from "/public-js-home-site-content.js";

let booted = false;

const MODULES = Object.freeze([
  ["widget-contract", installHomeWidgetContract],
  ["routes", installGameRouteNormalizer],
  ["modal", installModalSafety],
  ["auth", installAuthModalGuards],
  ["profile", installProfilePanelGuards],
  ["leaderboard", installLeaderboardGuards],
  ["stats", installStatsGuards],
  ["social", installSocialEntryGuards],
  ["hero", installHeroSliderGuards],
  ["reward", installRewardUiGuards],
  ["invite", installInviteUiGuards]
]);

function runModule(name, installer) {
  try {
    installer(document);
    return true;
  } catch (error) {
    console.error(`[PlayMatrix] home module failed: ${name}`, error);
    reportHomeError(`home.${name}`, error);
    return false;
  }
}

export async function bootHomeApplication() {
  if (booted) return true;
  booted = true;
  const results = MODULES.map(([name, installer]) => [name, runModule(name, installer)]);
  window.__PM_HOME_MODULES__ = Object.freeze(Object.fromEntries(results));
  installSiteContent().catch(() => null);
  return results.every(([, ok]) => ok);
}

export const homeModuleInfo = Object.freeze({ phase: 5, strategy: "static-esm-modules-plus-compat-runtime", cspSafe: true, fastBoot: true, modules: MODULES.map(([name]) => name) });
