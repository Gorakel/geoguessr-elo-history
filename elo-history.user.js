// ==UserScript==
// @name         GeoGuessr Ranked Elo History
// @namespace    https://www.geoguessr.com/
// @version      1.0.2
// @description  Shows a timeline of your overall Elo (ratingBefore / ratingAfter) from your ranked Duels.
// @icon         data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%20100%20100%27%3E%3Ctext%20y%3D%27.9em%27%20font-size%3D%2790%27%3E%F0%9F%93%88%3C%2Ftext%3E%3C%2Fsvg%3E
// @author       Gorakel
// @match        https://www.geoguessr.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=geoguessr.com
// @require      https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js
// @require      https://cdn.jsdelivr.net/npm/hammerjs@2.0.8/hammer.min.js
// @require      https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      www.geoguessr.com
// @connect      game-server.geoguessr.com
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

/*
 * How it works (short version):
 *   1. Read your activity feed and collect every ranked Duel (type 6, gameMode "Duels").
 *   2. For each Duel, ask the game server for the full result and read your ratingBefore / ratingAfter.
 *   3. Store the results in the userscript cache, so the next update only loads new games.
 *   4. Draw the ratings as a line chart (with filters and zoom).
 */

(function () {
    "use strict";

    // =====================================================================
    // 1. CONFIG
    // =====================================================================

    const DELAY_MS = 100;           // Pause between two game requests (be nice to the server)
    const MAX_FEED_PAGES = 9999999; // Safety limit; the feed only returns ~20 entries per page
    const RECORD_VERSION = 2;       // Bump this when the stored data format changes -> games get reloaded

    // Keys used to store data in the userscript cache (GM_setValue / GM_getValue)
    const KEY_GAMES = "ranked_elo_games_v1";
    const KEY_USER_ID = "ranked_elo_profile_v1";
    const KEY_SETTINGS = "ranked_elo_settings_v2";
    const KEY_FEED_COMPLETE = "ranked_elo_feed_complete_v1";

    // Readable names for the competitive game modes
    const MODE_NAMES = { StandardDuels: "Move", NoMoveDuels: "NM", NmpzDuels: "NMPZ" };
    const MODE_COLORS = { Move: "#4CAF50", NM: "#ffb142", NMPZ: "#ff5252" };
    const LINE_COLOR = "#a29bfe";

    // The three ways to lay out the X axis
    const X_MODES = ["day", "game", "index"];

    // =====================================================================
    // 2. SMALL HELPERS AND STORAGE
    // =====================================================================

    const $ = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // All games we know, stored as { gameId: record }. A record looks like this:
    //   { v: version, id, t: start time (ms), tb: elo before, ta: elo after,
    //     cm: mode name, w: won? (true/false/null), m: map name }
    let games = loadGames();

    // Filter settings that survive a page reload
    let settings = loadSettings();

    // State that only lives while the page is open
    let chart = null;                // The Chart.js instance
    let isUpdating = false;          // True while a download is running
    let zoomView = null;             // Currently zoomed X range: { min, max } (or null = show everything)
    let debugInfo = { feed: null, games: null };  // Numbers shown by the Debug button

    function loadGames() {
        const games = JSON.parse(GM_getValue(KEY_GAMES, "{}"));
        // Older script versions also stored team duels. Remove them.
        for (const id in games) {
            if (String(games[id].cm).startsWith("Team")) delete games[id];
            // Skip markers from older versions have no reason stored. Remove them,
            // so the next update checks those games again and records why they are skipped.
            if (games[id].skip === true) delete games[id];
            // Games from before the rating system change were wrongly marked as unusable.
            // They are readable now, so remove that old marker and load them again.
            if (games[id].skip === "finished, but you or your rating data are missing in the result") delete games[id];
        }
        return games;
    }

    function saveGames() {
        GM_setValue(KEY_GAMES, JSON.stringify(games));
    }

    function loadSettings() {
        const defaults = { from: "2026-06-29", to: "", mode: "all", x: "day" };
        const saved = JSON.parse(GM_getValue(KEY_SETTINGS, "{}"));
        const merged = { ...defaults, ...saved };
        if (!X_MODES.includes(merged.x)) merged.x = defaults.x;  // ignore values from old versions
        return merged;
    }

    function saveSettings() {
        GM_setValue(KEY_SETTINGS, JSON.stringify(settings));
    }

    // A game counts as "already loaded" if it is stored in the current data format
    function isLoaded(gameId) {
        return games[gameId] && games[gameId].v === RECORD_VERSION;
    }

    // =====================================================================
    // 3. HTTP
    // =====================================================================

    // Download a URL and return the parsed JSON. Rejects with { status } on errors.
    // GM_xmlhttpRequest is the userscript version of fetch(); it sends your login cookies.
    function getJson(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                headers: { Accept: "application/json" },
                timeout: 30000,
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(JSON.parse(response.responseText));
                    } else {
                        reject({ status: response.status });
                    }
                },
                onerror: () => reject({ status: 0 }),
                ontimeout: () => reject({ status: 524 }),
            });
        });
    }

    // Same as getJson, but tries again a few times (with growing pauses) on temporary errors.
    async function getJsonWithRetry(url) {
        let pause = 3000;
        for (let attempt = 1; attempt <= 4; attempt++) {
            try {
                return await getJson(url);
            } catch (error) {
                const permanent = [401, 403, 404].includes(error.status);
                if (permanent || attempt === 4) throw error;
                await sleep(pause);
                pause *= 2;
            }
        }
    }

    // Link to the result page of a duel (handy to look at a game that could not be loaded)
    const gameLink = (gameId) => "https://www.geoguessr.com/duels/" + gameId + "/summary";

    // Your own GeoGuessr user id (needed to find yourself inside a Duel). Cached after the first call.
    async function getMyUserId() {
        let id = GM_getValue(KEY_USER_ID, null);
        if (!id) {
            const profile = await getJson("https://www.geoguessr.com/api/v3/profiles/");
            id = profile.user.id;
            GM_setValue(KEY_USER_ID, id);
        }
        return id;
    }

    // =====================================================================
    // 4. ACTIVITY FEED -> LIST OF RANKED DUELS
    // =====================================================================

    // The "payload" of a feed entry is usually a JSON *string*. Turn it into an object/array.
    function parsePayload(payload) {
        return typeof payload === "string" ? JSON.parse(payload) : payload;
    }

    // Feed entries of type 7 are bundles that contain several single entries in their payload.
    // This returns one flat list of single entries (and also handles bundles inside bundles).
    function flattenEntries(entries) {
        const result = [];
        for (const entry of entries) {
            const payload = parsePayload(entry.payload);
            if (entry.type === 7 && Array.isArray(payload)) {
                result.push(...flattenEntries(payload));
            } else {
                result.push({ ...entry, payload: payload });
            }
        }
        return result;
    }

    // Keep only ranked Duels: entry type 6 with gameMode exactly "Duels" (so no team duels).
    function findRankedDuels(entries) {
        return flattenEntries(entries)
            .filter((e) => e.type === 6 && e.payload.gameMode === "Duels")
            .map((e) => ({
                gameId: e.payload.gameId,
                time: e.time,
                mode: e.payload.competitiveGameMode,
            }));
    }

    // Walk through the whole feed page by page and collect all ranked Duels.
    async function loadFeed(setStatus) {
        const found = new Map();      // gameId -> duel (a Map avoids duplicates)
        let pageToken = null;
        let pages = 0;
        let reachedEnd = false;

        // Once the whole feed has been read once, later updates may stop as soon as a page
        // contains only games we already have. Before that we always read everything,
        // otherwise an interrupted first run would leave permanent gaps.
        const mayStopEarly = GM_getValue(KEY_FEED_COMPLETE, false);

        while (pages < MAX_FEED_PAGES) {
            let url = "https://www.geoguessr.com/api/v4/feed/private?count=25";
            if (pageToken) url += "&paginationToken=" + encodeURIComponent(pageToken);

            const response = await getJsonWithRetry(url);
            pages++;

            const duels = findRankedDuels(response.entries);
            duels.forEach((d) => found.set(d.gameId, d));
            setStatus(`Reading feed: page ${pages}, ${found.size} ranked duels found`);

            if (mayStopEarly && duels.length > 0 && duels.every((d) => isLoaded(d.gameId))) break;

            pageToken = response.paginationToken;
            if (!pageToken || response.entries.length === 0) { reachedEnd = true; break; }
            await sleep(300);
        }

        if (reachedEnd) GM_setValue(KEY_FEED_COMPLETE, true);

        const times = [...found.values()].map((d) => d.time).sort();
        debugInfo.feed = { pages, rankedDuels: found.size, reachedEndOfFeed: reachedEnd, oldest: times[0], newest: times[times.length - 1] };
        return [...found.values()];
    }

    // =====================================================================
    // 5. ONE DUEL -> ONE RECORD
    // =====================================================================

    // Build our small record from the full game data. Returns null if the data is not usable.
    function buildRecord(duel, feedEntry, myUserId) {
        // Find yourself in the teams, and remember your team (needed to see who won)
        let me = null;
        let myTeam = null;
        for (const team of duel.teams) {
            for (const player of team.players) {
                if (player.playerId === myUserId) { me = player; myTeam = team; }
            }
        }
        if (!me) return null;

        // "ratingBefore" / "ratingAfter" = your overall Elo before / after this game.
        // New rating system: rankedSystemProgress. Games from before the change
        // (around 2026-06-29) only have the same two fields inside competitiveProgress.
        const change = me.progressChange || {};
        const progress = change.rankedSystemProgress || change.competitiveProgress;
        if (!progress) return null;

        const mode = feedEntry.mode || duel.options.competitiveGameMode;
        const won = duel.result.winningTeamId ? duel.result.winningTeamId === myTeam.id : null;

        return {
            v: RECORD_VERSION,
            id: feedEntry.gameId,
            t: Date.parse(duel.rounds[0].startTime),
            tb: progress.ratingBefore,
            ta: progress.ratingAfter,
            cm: MODE_NAMES[mode] || String(mode).replace("Duels", ""),
            w: won,
            old: !change.rankedSystemProgress,   // true = rating from the old system (other scale)
        };
    }

    // =====================================================================
    // 6. UPDATE: DOWNLOAD NEW GAMES
    // =====================================================================

    async function update(setStatus, reloadAll) {
        if (isUpdating) return;
        isUpdating = true;

        try {
            const myUserId = await getMyUserId();
            if (reloadAll) {
                games = {};
                GM_setValue(KEY_FEED_COMPLETE, false);
            }

            const feed = await loadFeed(setStatus);
            const todo = feed.filter((d) => !isLoaded(d.gameId));

            // Counters for the Debug view: why were games skipped?
            const counts = { loaded: 0, notFinished: 0, notUsable: 0, notFound: 0, otherErrors: {}, skipped: [] };
            // Remember every skipped game with the reason (shown in the Debug view, with a link)
            const skip = (entry, reason) => counts.skipped.push({ reason, time: entry.time, link: gameLink(entry.gameId) });
            debugInfo.games = counts;

            for (let i = 0; i < todo.length; i++) {
                const entry = todo[i];
                setStatus(`Loading game ${i + 1} / ${todo.length} ...`);

                try {
                    const duel = await getJsonWithRetry("https://game-server.geoguessr.com/api/duels/" + entry.gameId);
                    const record = duel.status === "Finished" ? buildRecord(duel, entry, myUserId) : null;

                    if (record) {
                        games[entry.gameId] = record;
                        counts.loaded++;
                    } else if (duel.status !== "Finished") {
                        counts.notFinished++;      // not stored; we try again on the next update
                        skip(entry, "game status is '" + duel.status + "' (not finished), will be retried");
                    } else {
                        counts.notUsable++;
                        const reason = "finished, but you or any rating data are missing in the result";
                        skip(entry, reason);
                        games[entry.gameId] = { v: RECORD_VERSION, id: entry.gameId, time: entry.time, skip: reason };  // never try again
                    }
                } catch (error) {
                    if (error.status === 404) {
                        counts.notFound++;
                        const reason = "game not found on the server (HTTP 404)";
                        skip(entry, reason);
                        games[entry.gameId] = { v: RECORD_VERSION, id: entry.gameId, time: entry.time, skip: reason };
                    } else {
                        counts.otherErrors[error.status] = (counts.otherErrors[error.status] || 0) + 1;
                        skip(entry, "request failed (HTTP " + error.status + "), will be retried");
                    }
                }

                // Save and redraw every 20 games, so nothing is lost if you close the tab
                if ((i + 1) % 20 === 0) { saveGames(); render(true); }
                await sleep(DELAY_MS);
            }

            saveGames();
            setStatus(`Done: ${feed.length} ranked duels in feed, ${counts.loaded} newly loaded, ${usableGames().length} usable in total.`);
            render(true);
        } catch (error) {
            setStatus("Error: " + (error.status || error.message || "unknown"));
        } finally {
            isUpdating = false;
        }
    }

    // =====================================================================
    // 7. FILTERING AND GROUPING
    // =====================================================================

    // All stored games that are real games (not "skip" markers), oldest first
    function usableGames() {
        return Object.values(games).filter((g) => !g.skip).sort((a, b) => a.t - b.t);
    }

    // Games that match the current filters (date range and mode)
    function filteredGames() {
        // "From" starts at 00:00:00 of that day, "To" ends at 23:59:59 (both in your local time)
        const from = settings.from ? new Date(settings.from + "T00:00:00").getTime() : -Infinity;
        const to = settings.to ? new Date(settings.to + "T23:59:59.999").getTime() : Infinity;

        return usableGames().filter(
            (g) => g.t >= from && g.t <= to && (settings.mode === "all" || g.cm === settings.mode)
        );
    }

    // Turn the games into chart points, depending on the X axis setting.
    // Every point is { x, y, game, day }  ("day" is only filled in per-day mode).
    function makePoints(list) {
        if (settings.x === "index") {
            return list.map((g, i) => ({ x: i + 1, y: g.ta, game: g }));
        }
        if (settings.x === "game") {
            return list.map((g) => ({ x: g.t, y: g.ta, game: g }));
        }

        // "day": one point per calendar day = your Elo at the end of that day.
        // This smooths out days with many games, and days without games are simply bridged.
        const days = new Map();
        for (const g of list) {
            const date = new Date(g.t);
            const key = date.getFullYear() + "-" + date.getMonth() + "-" + date.getDate();
            if (!days.has(key)) {
                const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).getTime();
                days.set(key, { x: noon, games: [] });
            }
            days.get(key).games.push(g);
        }
        return [...days.values()].map((d) => {
            const last = d.games[d.games.length - 1];
            const ratings = d.games.map((g) => g.ta);
            const startRating = d.games[0].tb;
            return {
                x: d.x,
                y: last.ta,
                game: last,
                day: {
                    count: d.games.length,
                    low: Math.min(...ratings),
                    high: Math.max(...ratings),
                    change: last.ta - startRating,
                    wins: d.games.filter((g) => g.w === true).length,
                    losses: d.games.filter((g) => g.w === false).length,
                    old: d.games.some((g) => g.old),
                },
            };
        });
    }

    const signed = (n) => (n >= 0 ? "+" : "") + n;

    // =====================================================================
    // 8. DRAWING
    // =====================================================================

    // Redraw stats and chart. "keepZoom" is true for background redraws during a download.
    function render(keepZoom = false) {
        if (!$("elo-panel").classList.contains("open")) return;
        if (!keepZoom) zoomView = null;

        updateModeDropdown();
        const list = filteredGames();
        showStats(list);
        showChart(list);
    }

    function showStats(list) {
        const stats = $("elo-stats");
        if (list.length === 0) {
            stats.textContent = usableGames().length === 0
                ? 'No data yet - click "Update".'
                : "No games match the current filters.";
            return;
        }
        const ratings = list.map((g) => g.ta);
        const wins = list.filter((g) => g.w === true).length;
        const losses = list.filter((g) => g.w === false).length;
        const first = list[0];
        const last = list[list.length - 1];
        const outdated = Object.values(games).filter((g) => g.v !== RECORD_VERSION).length;

        stats.innerHTML =
            `<span>Current <b>${last.ta}</b></span>` +
            `<span>Peak <b>${Math.max(...ratings)}</b></span>` +
            `<span>Low <b>${Math.min(...ratings)}</b></span>` +
            `<span>Change <b>${signed(last.ta - first.tb)}</b></span>` +
            `<span>Games <b>${list.length}</b></span>` +
            `<span>W/L <b>${wins}/${losses}</b></span>` +
            (outdated ? `<span class="warn">${outdated} outdated records - click "Update"</span>` : "");
    }

    function showChart(list) {
        const points = makePoints(list);
        const perDay = settings.x === "day";
        const perGame = settings.x === "game";

        if (chart) chart.destroy();
        chart = new Chart($("elo-canvas").getContext("2d"), {
            type: "line",
            data: {
                datasets: [{
                    data: points,
                    borderColor: LINE_COLOR,
                    backgroundColor: "rgba(162,155,254,.12)",
                    fill: true,
                    borderWidth: 1.8,
                    tension: perDay ? 0.25 : 0.05,
                    cubicInterpolationMode: perDay ? "monotone" : "default",
                    pointRadius: points.length > 400 ? 0 : 3,
                    pointHoverRadius: 5,
                    // In per-game mode the dots are colored by game mode (Move / NM / NMPZ)
                    pointBackgroundColor: points.map((p) => (perDay ? LINE_COLOR : MODE_COLORS[p.game.cm] || LINE_COLOR)),
                    pointBorderColor: points.map((p) => (perDay ? LINE_COLOR : MODE_COLORS[p.game.cm] || LINE_COLOR)),
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                parsing: false,                      // our points are already { x, y }
                interaction: { intersect: false, mode: "nearest", axis: "x" },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { title: tooltipTitle, label: tooltipLines } },
                    zoom: {
                        limits: { x: { min: "original", max: "original", minRange: settings.x === "index" ? 5 : perDay ? 2 * 86400000 : 3600000 } },
                        zoom: {
                            wheel: { enabled: true },
                            pinch: { enabled: true },
                            mode: "x",
                            onZoomComplete: ({ chart }) => fitYAxis(chart),
                        },
                        pan: {
                            enabled: true,
                            mode: "x",
                            onPanComplete: ({ chart }) => fitYAxis(chart),
                        },
                    },
                },
                scales: {
                    x: {
                        type: "linear",
                        ...(zoomView ? { min: zoomView.min, max: zoomView.max } : {}),
                        ticks: {
                            color: "#fff",
                            maxTicksLimit: 10,
                            callback: (value) => (settings.x === "index" ? value : new Date(value).toLocaleDateString("en-GB")),
                        },
                        grid: { color: "rgba(255,255,255,.08)" },
                    },
                    y: { ticks: { color: "#fff" }, grid: { color: "rgba(255,255,255,.08)" } },
                },
            },
        });
    }

    function tooltipTitle(items) {
        const point = items[0].raw;
        const date = new Date(point.game.t);
        return point.day ? date.toLocaleDateString("en-GB") : date.toLocaleString("en-GB");
    }

    function tooltipLines(item) {
        const p = item.raw;
        const oldNote = "Old rating system (different scale)";
        if (p.day) {
            const lines = [
                `Elo at end of day: ${p.y}`,
                `${p.day.count} games, day change ${signed(p.day.change)}`,
                `Low ${p.day.low} / High ${p.day.high} / W-L ${p.day.wins}-${p.day.losses}`,
            ];
            if (p.day.old) lines.push(oldNote);
            return lines;
        }
        const result = p.game.w === true ? "Win" : p.game.w === false ? "Loss" : "Draw";
        const lines = [`Elo ${p.y} (${signed(p.game.ta - p.game.tb)})`, `${p.game.cm} - ${result}`];
        if (p.game.old) lines.push(oldNote);
        return lines;
    }

    // ---- Zoom helpers ----

    // After zooming or panning: remember the visible range and fit the Y axis to the visible points
    function fitYAxis(c) {
        const xScale = c.scales.x;
        zoomView = { min: xScale.min, max: xScale.max };

        const visible = c.data.datasets[0].data.filter((p) => p.x >= xScale.min && p.x <= xScale.max);
        if (visible.length === 0) return;

        const ratings = visible.map((p) => p.y);
        const low = Math.min(...ratings);
        const high = Math.max(...ratings);
        const padding = Math.max(5, (high - low) * 0.08);
        c.options.scales.y.min = low - padding;
        c.options.scales.y.max = high + padding;
        c.update("none");
    }

    function zoomBy(factor) {
        if (!chart) return;
        chart.zoom({ x: factor });
        fitYAxis(chart);
    }

    // =====================================================================
    // 9. USER INTERFACE
    // =====================================================================

    const CSS = `
	#elo-btn { position: fixed; left: 16px; bottom: 16px; z-index: 99998; background: #6c5ce7; color: #fff; border: 0; border-radius: 24px; padding: 10px 16px; font: 600 14px sans-serif; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
	#elo-panel { position: fixed; inset: 5vh 5vw; z-index: 99999; background: #1a1a2e; color: #fff; border: 1px solid #3c3c7e; border-radius: 10px; display: none; flex-direction: column; padding: 14px; font: 13px sans-serif; }
	#elo-panel.open { display: flex; }
	#elo-panel .bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; padding-right: 40px; }
	#elo-panel button, #elo-panel select, #elo-panel input { background: #2c2c54; color: #fff; border: 1px solid #4c4c8e; border-radius: 6px; padding: 5px 10px; cursor: pointer; font: 13px sans-serif; color-scheme: dark; }
	#elo-panel button:hover { background: #3c3c7e; }
	#elo-panel label { display: flex; align-items: center; gap: 4px; }
	#elo-panel #elo-close { position: absolute; top: 8px; right: 8px; width: 30px; height: 30px; padding: 0; font-size: 16px; }
	#elo-status { margin-left: auto; opacity: .8; }
	#elo-stats { display: flex; gap: 18px; flex-wrap: wrap; margin: 4px 0 8px; }
	#elo-stats b { font-size: 15px; }
	#elo-stats .warn { color: #ffb142; }
	#elo-chart-box { flex: 1; min-height: 0; position: relative; }
	#elo-debug { display: none; flex: 1; overflow: auto; margin: 0; padding: 8px; background: #11111f; border-radius: 6px; user-select: text; white-space: pre-wrap; }
	`;

    const PANEL_HTML = `
		<button id="elo-close" title="Close">✕</button>
		<div class="bar">
			<button id="elo-update">Update</button>
			<button id="elo-reload">Reload all</button>
			<label>From <input type="date" id="elo-from"></label>
			<label>To <input type="date" id="elo-to"></label>
			<button id="elo-reset-dates">Reset dates</button>
			<select id="elo-mode"></select>
			<select id="elo-x">
				<option value="day">X: Time (per day, smoothed)</option>
				<option value="game">X: Time (per game)</option>
				<option value="index">X: Game number</option>
			</select>
			<button id="elo-zoom-in" title="Zoom in">＋</button>
			<button id="elo-zoom-out" title="Zoom out">－</button>
			<button id="elo-zoom-reset">Reset zoom</button>
			<button id="elo-csv">CSV</button>
			<button id="elo-debug-btn">Debug</button>
			<span id="elo-status"></span>
		</div>
		<div id="elo-stats"></div>
		<pre id="elo-debug"></pre>
		<div id="elo-chart-box"><canvas id="elo-canvas"></canvas></div>
	`;

    // Build the panel once. It stays hidden until you click the Elo button.
    function createPanel() {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        const panel = document.createElement("div");
        panel.id = "elo-panel";
        panel.innerHTML = PANEL_HTML;
        document.body.appendChild(panel);

        const setStatus = (text) => { $("elo-status").textContent = text; };

        // Show the saved filter settings
        $("elo-from").value = settings.from;
        $("elo-to").value = settings.to;
        $("elo-x").value = settings.x;

        // Buttons
        $("elo-close").onclick = () => panel.classList.remove("open");
        $("elo-update").onclick = () => update(setStatus, false);
        $("elo-reload").onclick = () => {
            if (confirm("Delete the cache and reload all ranked duels? This can take a while.")) update(setStatus, true);
        };
        $("elo-zoom-in").onclick = () => zoomBy(1.4);
        $("elo-zoom-out").onclick = () => zoomBy(1 / 1.4);
        $("elo-zoom-reset").onclick = () => render();
        $("elo-csv").onclick = exportCsv;
        $("elo-debug-btn").onclick = toggleDebug;
        $("elo-reset-dates").onclick = () => {
            $("elo-from").value = "2026-06-29";
            $("elo-to").value = "";
            onFilterChange();
        };

        // Filters: save them and redraw whenever one changes
        for (const id of ["elo-from", "elo-to", "elo-mode", "elo-x"]) {
            $(id).onchange = onFilterChange;
        }
    }

    function onFilterChange() {
        settings.from = $("elo-from").value;
        settings.to = $("elo-to").value;
        settings.mode = $("elo-mode").value;
        settings.x = $("elo-x").value;
        saveSettings();
        render();
    }

    // Fill the mode dropdown with the modes that exist in your data
    function updateModeDropdown() {
        const modes = [...new Set(usableGames().map((g) => g.cm))].sort();
        if (settings.mode !== "all" && !modes.includes(settings.mode)) modes.push(settings.mode);

        const select = $("elo-mode");
        select.innerHTML = '<option value="all">All modes</option>' + modes.map((m) => `<option>${m}</option>`).join("");
        select.value = settings.mode;
    }

    // Download all stored games as a CSV file
    function exportCsv() {
        const lines = ["time,game_id,mode,elo_before,elo_after,change,won"];
        for (const g of usableGames()) {
            lines.push([new Date(g.t).toISOString(), g.id, g.cm, g.tb, g.ta, g.ta - g.tb, g.w === null ? "" : g.w ? 1 : 0].join(","));
        }
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
        link.download = "ranked-elo.csv";
        link.click();
        URL.revokeObjectURL(link.href);
    }

    // Show / hide a text report that helps to find out why games might be missing
    function toggleDebug() {
        const box = $("elo-debug");
        const show = box.style.display !== "block";

        const perMonth = {};
        for (const g of usableGames()) {
            const month = new Date(g.t).toISOString().slice(0, 7);
            perMonth[month] = (perMonth[month] || 0) + 1;
        }
        box.textContent = JSON.stringify({
            storedRecords: Object.keys(games).length,
            usableGames: usableGames().length,
            gamesPerMonth: perMonth,
            lastFeedRead: debugInfo.feed || "no update since the page was loaded",
            lastGameDownloads: debugInfo.games || "no update since the page was loaded",
            // Games marked as "never try again" in earlier updates (older markers have no reason or time)
            permanentlySkipped: Object.values(games).filter((g) => g.skip).map((g) => ({
                reason: g.skip === true ? "unknown (marked by an older version)" : g.skip,
                time: g.time,
                link: gameLink(g.id),
            })),
            feedFullyReadOnce: GM_getValue(KEY_FEED_COMPLETE, false),
        }, null, 2);

        box.style.display = show ? "block" : "none";
        $("elo-chart-box").style.display = show ? "none" : "";
        if (!show) render();
    }

    // =====================================================================
    // 10. ELO BUTTON (only on some pages)
    // =====================================================================

    // GeoGuessr never reloads the page when you navigate, so we have to watch the URL ourselves.
    // The button is only shown on /multiplayer/duels and /me/profile (an optional language
    // prefix like /en or /pt-BR is allowed).
    function isAllowedPage() {
        return /^(\/[a-z]{2}(-[A-Za-z]{2,4})?)?(\/me\/profile)?\/?$/.test(location.pathname);
    }
    // Add or remove the button depending on the current page
    function updateButton() {
        const button = $("elo-btn");
        if (isAllowedPage()) {
            if (button) return;                       // already there
            const newButton = document.createElement("button");
            newButton.id = "elo-btn";
            newButton.textContent = "📈 Elo";
            newButton.onclick = () => {
                $("elo-panel").classList.toggle("open");
                render();
            };
            document.body.appendChild(newButton);
        } else {
            if (button) button.remove();
            $("elo-panel").classList.remove("open");  // also hide the panel when leaving
        }
    }

    // Wrap pushState / replaceState so we get an event whenever the page changes its URL
    for (const method of ["pushState", "replaceState"]) {
        const original = history[method];
        history[method] = function () {
            const result = original.apply(this, arguments);
            window.dispatchEvent(new Event("elo-urlchange"));
            return result;
        };
    }
    window.addEventListener("elo-urlchange", updateButton);
    window.addEventListener("popstate", updateButton);   // browser back / forward
    setInterval(updateButton, 1000);                     // safety net in case an event is missed

    // =====================================================================
    // 11. START
    // =====================================================================

    createPanel();
    updateButton();
})();

