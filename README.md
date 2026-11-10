# bike-mechanic-pad

A local-first, offline-first digital clipboard for independent and solo bike mechanics. It is intended to keep customer and bicycle details, work orders, pricing, and component service history together at the repair stand, without requiring an always-on internet connection or a hosted application account.

The project is small and self-supported. It is provided as-is, with no paid support, service-level agreement, or promise that it will meet any particular shop's needs. It is open source software, not a managed business system.

## What It Does

- Keep customer contact details and notes alongside their bicycles.
- Create work orders with issue summaries, notes, labor and parts line items, quantities, and prices.
- Track order status from open through completion or cancellation, and see order totals on the dashboard.
- Record service dates for a bicycle's chain, cassette, brake pads, fork, rear shock, and bottom bracket. Completing a work order can update the ledger for the components tagged on its line items.
- Keep the working database on the device in browser-managed storage. Sync is optional: pair nearby devices directly, or connect your own WebDAV server, from Settings.

The app is designed as a lightweight clipboard, not a full shop-management or accounting system. It does not replace professional bookkeeping, payment processing, inventory control, customer communication, or a tested backup process.

## Offline Use

Open the app once with a network connection. A service worker (`src/service-worker.ts`) then caches the whole app, and it works offline from the next load on. The same worker adds the COOP/COEP headers that browser storage (OPFS) needs on hosts that cannot send them. A web manifest lets you install it to a tablet home screen.

## Getting Started

The app is a Progressive Web App. Open it in a supported browser; install it to a device's home screen if you want an app-like shortcut. The database is local to the browser profile until you configure sync.

Typical workflow:

1. In **Customers**, add a customer, then add their bicycle with its brand and model.
2. Create a work order for that bicycle and describe the reported issue.
3. Add labor or parts line items. Enter unit prices as dollar amounts; the app stores and calculates money in integer cents.
4. Update the work order status as the repair progresses. Tag a line item with a component when it represents service to a tracked component.
5. Mark the work order **Completed** to record the local service date for its tagged components. Check the bike's service history when planning future work.

### Optional Sync

Sync is opt-in, and there are two ways to do it under **Settings**. Both can run at once.

**Nearby device.** With both devices on the same Wi-Fi, press **Show my code** on one and **Scan a code** on the other, then scan the reply back. Nothing leaves your network. With three or more devices, pair each two of them once; each device syncs only with the devices it is linked to, and remembers them until you press **Forget**. Links last while the app stays open, and the app keeps the screen awake where the device allows it. A browser cannot accept a connection on its own, so a device that restarts or reloads must pair once more with any one device still connected, and the rest of its links then come back by themselves. If every device dropped, repeat that for each one after the first. Browsers limit the saved security certificate to one year, so expect to pair again about once a year. Networks that isolate devices from each other, such as many guest Wi-Fi networks, will not connect.

**WebDAV server.** For syncing when devices are apart, enter the address, username, and password of a WebDAV server you control, such as Nextcloud or a NAS, and use the same sync folder on every device. The address must be https, and the server must allow this app through CORS; **Server setup** in Settings lists exactly what to allow. The password is stored unencrypted in the browser, so use an app password where your server offers one. Changing the folder after sync has begun starts a fresh sync folder; it does not move existing data for you.

Sync is not a backup guarantee. It depends on your network, your server, and the correct folder being used on each device. A newly added device receives only about the last 30 days of changes, so restore a backup on it first. Confirm that your devices have synced successfully, and maintain an independent backup and a recovery procedure that you have tested.

> **Security warning: GitHub Pages hosting.** Browser storage (localStorage and the OPFS database) belongs to an *origin*, not a URL path. Every project site under `yourname.github.io` shares one origin, so any other page hosted on the same GitHub account can read this app's local database and saved Dropbox tokens. For real shop data, serve the app from a custom domain or a dedicated host that runs only this app.

## Important: Self-Supported Software and Risk

**Use this software at your own risk. You are responsible for protecting your data and for any consequences of using it in your business.** The maintainer does not accept responsibility for lost or corrupted customer, bicycle, work order, or service-history data; lost revenue; missed work; business interruption; or other business losses arising from the software, its use, its failure, or reliance on sync. To the fullest extent permitted by applicable law, the software is provided without warranties, and no support or recovery service is promised.

Do not make this app the only place you keep business-critical information. Keep independent backups, verify that they can be restored, and make your own assessment of privacy, security, and record-retention requirements before entering customer data. Local browser storage can be lost, for example if browser data or a device is removed or damaged. Optional sync can also fail or be misconfigured.

## Development

Requires Node.js 24 or newer.

```sh
npm install
npm run dev
```

Useful checks:

```sh
npm run check
npm test
npm run test:e2e
npm run build
```

## License

Distributed under the GNU General Public License v3.0 (GPLv3). You may use, modify, and distribute it under the license terms. See [LICENSE](LICENSE) for the full license, including its warranty and liability terms.