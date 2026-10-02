# Sinking Fund Tracker

A simple offline web app for tracking a group sinking fund: member contributions, member loans, loan interest, and the December distribution.

## Two ways to run it

**Online (shared with members):** the app is hosted on GitHub Pages and the data is stored in Firebase Firestore.
- Anyone with the link can **view** the fund.
- Only admin Google accounts can **edit**: they're listed as hashes in `firebase-config.js`, and enforced by the Firestore rules in the Firebase console. Sign in with the **Admin sign in** button.

**Local only:** if `firebase-config.js` still has the `PASTE_...` placeholders, or you double-click `index.html` on your computer, the app runs offline.
- Data is saved in that browser only.
- The header shows "Saved on this computer only".

In both modes, use **Settings → Export backup** regularly and keep the `.json` file somewhere safe. **Settings → Import backup** restores it. Importing while signed in as admin online uploads the data for everyone.

## Online setup (one time)

1. **Firebase:** at https://console.firebase.google.com, create a project. Google Analytics is not needed.
   - **Build → Firestore Database → Create database.** Production mode, region `asia-southeast1`.
   - **Build → Authentication → Get started → Sign-in method → Google → Enable.**
   - **Authentication → Settings → Authorized domains:** add `<your-github-username>.github.io`.
   - **Project settings → General → Your apps → Web (`</>`).** Register the app and copy the config values into `firebase-config.js`.
   - **Firestore → Rules:** paste `firestore.rules` with your admin email filled in, then **Publish**.
   - Add the SHA-256 hash of the admin email (lowercase) to `adminEmailHashes` in `firebase-config.js`. Run `printf '%s' 'name@gmail.com' | sha256sum`. Don't commit the plain email to this public repo.
2. **GitHub Pages:** push this folder to a GitHub repo, then go to **Settings → Pages → Deploy from branch → `main` / root**.
   - The site will be at `https://<your-github-username>.github.io/sinking-fund-tracker/`.
3. **Move your existing data:**
   - In the local copy, go to **Settings → Export backup**.
   - On the website, **Admin sign in**, then **Settings → Import backup**.

**Privacy:** anyone who has the link can see members' names and amounts. Share it only in your group chat, and consider using nicknames.

## Fund rules built in

| Rule | Setting |
|---|---|
| Contribution | Fixed amount per head per period (default ₱500, twice a month on the 15th and end of month) |
| Loan terms | 1 month @ 5%/mo, 2 months @ 4%/mo, 3 months @ 3%/mo |
| Loan interest | Flat on principal: ₱10,000 × 4% × 2 mo = ₱800 interest, ₱10,800 total, paid in 2 equal monthly installments |
| Year-end retention | 10% of the total fund balance carries over to next year |
| Interest sharing | Divided equally per registered head |

You can change all of these in **Settings**. Each loan keeps the rate it was released at.

## How the numbers are computed

- **Cash on hand** = carry-over + contributions + loan payments + other income − loans released − expenses
- **Total fund value** = cash on hand + unpaid loan principal
- **Net contribution (per member)** = contributions − their unpaid loan balance
- **Interest earned**: each loan payment is split between principal and interest in the same ratio as the loan (e.g. a 2-month loan is 800/10,800 interest)
- **Year-end:**
  - Total fund balance = carry-over + contributions + interest + (other income − expenses)
  - Earnings pool = carry-over + interest + (other income − expenses), divided equally per head
  - Gross share = own contributions + per-head earnings × heads
  - Net share = gross share − 10% (retained)
  - **Payout = net share − any unpaid loan balance**

Last year's carry-over is shared per head along with the interest, so the fund never builds up money that belongs to nobody.

## Typical workflow

1. **Settings:** set the fund name, contribution per head, schedule, and starting month.
2. **Members:** add each member with their number of heads. Set "Joined" if they started mid-year.
3. Each payday, go to **Contributions → Record dues for many**. Uncheck anyone who didn't pay.
4. **Loans → New loan** to release a loan (the schedule preview shows due dates). Click **Pay** when installments come in.
5. **Ledger:** record bank fees or other income, or export a CSV.
6. **December → Year-End:** review and print the payout sheet, then **Close year**. This:
   - downloads a backup,
   - marks open loans as paid by payout deduction,
   - saves the payout record,
   - starts next year with the 10% carry-over.

Click a member's name on the Dashboard to see a printable **statement** you can send them.
