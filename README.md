# Pocket Ledger

A free, private expense tracker that installs on your iPhone Home Screen and works offline.
No account, no server, no cost. Everything you enter is stored on your device in IndexedDB.

Plain HTML, CSS and JavaScript. No build step, no dependencies, no third-party requests.

## Install on iPhone

1. Open the app's URL in **Safari**.
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
3. Open **Ledger** from the Home Screen. It runs full screen and works without a connection.

Install it before you start entering data: the Home Screen app keeps its own storage, separate from the Safari tab.

## Using it

- **Add an expense:** tap **+**, type the amount, tap a category, tap **Save**. The date is today and the payment method is the one you used last. Your most recent categories come first.
- **Merchant:** optional. Merchants you have used appear as one-tap suggestions and bring their usual category with them.
- **Income:** switch the toggle at the top of the entry sheet to *Income*.
- **Edit or delete:** tap any transaction.
- **Receipts:** tap *Attach* in the entry sheet to take or choose a photo.
- **Transactions tab:** search, and filter by date range, type, category and payment method.
- **Analytics tab:** monthly totals, change against the previous month, category breakdown and a six-month comparison.
- **Budgets tab:** tap *Total monthly budget* or any category to set an amount. Enter 0 to remove it.
- **Recurring & bills:** Settings → *Recurring & bills*. Items due in the next 30 days show on Home. Tap **Log** when you pay one, or tick *Add automatically* to have it recorded on the due date.
- **Categories and payment methods:** Settings → *Categories* / *Payment methods*.
- **Light / dark:** Settings → *Appearance*.

## Backing up

Your data exists only on this device. It does not sync, and it is erased if you delete the app or clear Safari website data.

- **Back up:** Settings → *Back up now* → **Save to Files** (iCloud Drive is a good place). This writes one JSON file with everything, receipts included.
- **Restore:** Settings → *Restore from backup* → pick the file. *Merge* adds what is missing and skips duplicates; *Replace everything* makes the device match the backup.
- **Spreadsheet:** Settings → *Export CSV*. *Import CSV* reads the same columns back: `Date, Type, Amount, Category, Merchant, Payment Method, Note`.

The app reminds you on Home when it has been more than two weeks since the last backup.

## Updating the app

Edit the files, bump `CACHE` in `sw.js`, and push. Installed copies pick up the new version the second time they are opened while online.
