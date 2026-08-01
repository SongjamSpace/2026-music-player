/**
 * The single global every renderer file hangs off.
 *
 * ES modules do not work over file:// (Chromium blocks them as cross-origin),
 * so the renderer is a set of ordered classic scripts sharing this namespace.
 * Rule: no file may touch an MP.* member at parse time — only inside functions
 * called after DOMContentLoaded. js/main.js loads last and is the only caller
 * of boot().
 */
window.MP = window.MP || {};
