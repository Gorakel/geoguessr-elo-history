# GeoGuessr Ranked Elo History

A userscript that adds an interactive timeline of your overall **Elo rating** to GeoGuessr, based on your ranked Duels (`ratingBefore` / `ratingAfter`).

## Features

- 📈 **Elo timeline** drawn as a line chart (Chart.js) with zoom and pan
- 🗓️ **Three X-axis modes**
    - _Time (per day, smoothed)_: one point per day = your Elo at the end of that day
    - _Time (per game)_: one point per game, colored by game mode
    - _Game number_: games in order, without time gaps
- 🎯 **Filters** for date range and game mode (Move / NM / NMPZ)
- 📊 **Stats** for the current selection: current, peak and lowest Elo, total change, number of games and win/loss record
- 💬 **Tooltips** with Elo change, game mode, result and daily low/high
- 💾 **Local cache**: only new games are downloaded on later updates
- 📤 **CSV export** of all stored games
- 🐞 **Debug view** showing why individual games were skipped (with links to the games)

## Installation

1. Install a userscript manager, for example [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Create a new userscript and paste the contents of the script file, or open the raw script URL if you host it.
3. Save the script and open [geoguessr.com](https://www.geoguessr.com/).

The script loads these libraries from jsDelivr: `chart.js`, `hammerjs` and `chartjs-plugin-zoom`.

## Usage

1. Open GeoGuessr and go to the main page or your profile (`/me/profile`).
2. Click the **📈 Elo** button in the bottom-left corner.
3. Click **Update** to download your ranked Duels. The first run can take a while, depending on how many games you have played.
4. Use the filters, X-axis selector and zoom controls to explore your rating history.

### Controls

| Control                  | Description                                          |
| ------------------------ | ---------------------------------------------------- |
| **Update**               | Loads new games only (uses the cache)                |
| **Reload all**           | Deletes the cache and loads everything again         |
| **From / To**            | Date range filter (local time)                       |
| **Reset dates**          | Resets the range to the default start date           |
| **Mode dropdown**        | Show all modes or a single one                       |
| **X dropdown**           | Switch between day, game and game-number axis        |
| **＋ / － / Reset zoom** | Zoom buttons (mouse wheel, pinch and drag also work) |
| **CSV**                  | Exports all stored games as `ranked-elo.csv`         |
| **Debug**                | Shows internal numbers and skipped games             |

## How it works

1. Reads your private activity feed and collects every ranked Duel (entry type 6, game mode `Duels`; team duels are ignored).
2. Requests the full result of each Duel from the game server and reads your `ratingBefore` / `ratingAfter`.
3. Stores the results in the userscript storage (`GM_setValue`), so later updates only fetch new games.
4. Draws the ratings as a line chart.

Requests are throttled (100 ms between games) and retried with growing pauses on temporary errors.

## Notes

- Ratings from before the rating system change (around 2026-06-29) use a different scale. The chart's default start date is set to **2026-06-29**; such games are marked as "Old rating system" in tooltips.
- The button is only shown on the home page and the profile page.
- All data stays in your browser's userscript storage. The only requests go to `www.geoguessr.com` and `game-server.geoguessr.com`, using your existing login session.
- This is an unofficial tool and not affiliated with GeoGuessr. The used API endpoints are undocumented and may change at any time.
- Code was converted to js via Claude Sonnet 5.5.
- Readme was created with help of Claude Sonnet 5.5.

## Permissions

| Grant                                                     | Purpose                       |
| --------------------------------------------------------- | ----------------------------- |
| `GM_xmlhttpRequest`                                       | Requests to the GeoGuessr API |
| `GM_getValue` / `GM_setValue`                             | Local cache and settings      |
| `@connect www.geoguessr.com`, `game-server.geoguessr.com` | Allowed domains               |

## License

MIT
