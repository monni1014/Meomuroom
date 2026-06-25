# Meomuroom RPA

RPA work starts from `v7`.

Keep `v6` as the stable rollback branch.

## 1. IPRoyal proxy test

Add these values to `.env`.

```env
IPROYAL_PROXY_HOST="host from IPRoyal"
IPROYAL_PROXY_PORT="port from IPRoyal"
IPROYAL_PROXY_PROTOCOL="http"
IPROYAL_PROXY_USER="username from IPRoyal"
IPROYAL_PROXY_PASS="password from IPRoyal"
RPA_HEADLESS="false"
RPA_MIN_DELAY_MS="900"
RPA_MAX_DELAY_MS="2200"
```

Run:

```bash
npm run rpa:test-proxy
```

If the output country is `KR`, the proxy base test passed.

## 2. Build order

1. Save Naver login session.
2. Open Naver booking detail URL.
3. Read full name and phone number.
4. Block/unblock Naver slots.
5. Open SpaceCloud booking detail URL.
6. Read SpaceCloud phone number and cancellation fee.

Every RPA action must verify the result after it runs.
If it fails, save a screenshot and leave a status that a person can check.

## 3. Naver session test

Run:

```bash
npm run rpa:naver-login
```

A browser opens through the IPRoyal proxy. Log in manually, then press Enter in the terminal.
The saved login session is stored under `rpa/.auth/`, which is ignored by git.

After that, open a booking detail URL:

```bash
npm run rpa:naver-open -- "https://partner.booking.naver.com/bizes/1473933/booking-list-view/bookings/BOOKING_ID"
```

If it opens the reservation detail page without asking for login again, the base RPA session flow is working.

## 4. Naver slot block/open test

This follows the screen order:

1. Open reservation product list.
2. Select `Meomuroom booking 1` or `Meomuroom booking 2`.
3. Open the schedule tab.
4. Move to the target week.
5. Open the target day's slot panel.
6. Toggle target hours.

For safety, do not let RPA guess-click icons on the product list page.
Open the product edit page manually once, copy the URL, then pass it with `--product-url`.

Dry run first:

```bash
npm run rpa:naver-slots -- --room=1 --date=2026-06-29 --start=09:00 --end=11:00 --mode=close --product-url="PRODUCT_EDIT_URL"
```

Actually click toggles:

```bash
npm run rpa:naver-slots -- --room=1 --date=2026-06-29 --start=09:00 --end=11:00 --mode=close --product-url="PRODUCT_EDIT_URL" --apply
```

Use `--mode=open` to reopen slots.
