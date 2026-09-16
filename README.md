# Savage Presidential Scratch & Win — server-backed build

## What is included
- Server-side prize selection using Node crypto.randomInt (not browser Math.random).
- User registration/login.
- Wallet balance stored in the database in kobo.
- Scratch cards stored server-side and revealed once.
- Withdrawal requests with bank details.
- Admin dashboard for pending withdrawals and prize/weight controls.
- Admin can mark withdrawals paid or reject them; rejection refunds the wallet.

## Important compliance / payout note
This project is a technical implementation scaffold. Do not accept paid entries or launch a chance-based cash promotion until you have obtained any licences/permits/approvals required for your jurisdiction. In Nigeria, the NLRC states that promotional schemes with an element of chance require approval before launch. The included withdrawal flow is intentionally manual: an authorised administrator verifies and pays the bank transfer, then marks the request paid.

## Install
1. Use Node.js hosting/VPS that supports a persistent Node process.
2. Run `npm install`.
3. Set environment variables:
   - ADMIN_USER=your_admin_username
   - ADMIN_PASSWORD=your_strong_admin_password
   - SESSION_SECRET=a_long_random_secret
   - NODE_ENV=production
   - PORT=3000 (or the port assigned by your host)
4. Run `npm start`.
5. Open `/` for the player game and `/admin` for the admin dashboard.

## Before production
- Replace the demo/default prize table with the exact approved prize schedule.
- Put the app behind HTTPS.
- Use a production database/managed MySQL or PostgreSQL if scaling beyond a small deployment.
- Add identity/KYC and age/eligibility checks as required by the approved rules.
- Add an audited payment provider integration only after the payout account and compliance requirements are in place.
- Do not put payment secrets in frontend JavaScript.
