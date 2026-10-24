# Mercator Online – internal web API (reverse-engineered)

What `mercatoronline.si`'s own pages call behind the scenes, as observed on **23. 10. 2026** from the site's
JavaScript (`cart.min.js`, `step2.min.js`, page configs) and from network traffic of a real session.
These endpoints are **undocumented and can change without notice** – keep a fallback.

**Confidence**

| Mark | Meaning |
|---|---|
| ✅ verified | called successfully, request and response seen |
| 👁 seen | URL and parameters read from the site's own code or traffic, not called by us yet |
| ❓ inferred | deduced from code; details to confirm in a recorded checkout |

---

## 1. Conventions

- **Origin:** `https://mercatoronline.si`. All calls are same-origin from a page of the shop.
- **Auth:** session cookies. Login goes through Mercator's central login (`profil.mercator.si`, see §2);
  after that every request below runs as the logged-in user. No CSRF token was seen on the AJAX calls.
- **AJAX headers:** `X-Requested-With: XMLHttpRequest`; POST bodies are
  `application/x-www-form-urlencoded; charset=UTF-8` (jQuery encoding: nested arrays as
  `products[0][id]=…&products[0][quantity]=…`).
- **`cartConf`:** always `default` (the page config has `cartConf: {"default": {…}}`).
- **Responses:** JSON with a `success` boolean; errors carry `error` or `message` (shown to users by `ShopLib.Popups`).
- **Logged-in flag:** every page sets `ShopLib.loggedIn = true|false` in an inline script – the cheapest login check.
- **Product ids:** `itemId` / `data.cinv` in search results (e.g. `19148905`); also in product URLs `/izdelek/<id>/<slug>`.

## 2. Login ✅ (via the form, not an API)

`GET /prijava` renders a form that **POSTs to `https://profil.mercator.si/sign-in.aspx?RETURNURI=https%3A%2F%2Fmercatoronline.si%2Fsso%2Fsso%2Flogin%2Fshop&LOGINCODE=MIT`**

| Field | Value |
|---|---|
| `txtUserName` | e-mail |
| `txtPassword` | password |
| `chkRememberMe` | `on` (optional) |
| hidden fields | `btnLogin`, `POSTURI=https://mercatoronline.si/sso/`, `storeId=4040`, `catalogId=10701`, … (copy from the form) |

Then redirects `profil.mercator.si → /sso/sso/login/shop → shop`. Logout: `profil.mercator.si/sign-out.aspx?RETURNURI=…/sso/sso/logout/shop`.
*Recommendation:* keep doing this in a real browser (redirect chain, cookies on two domains) and send all other calls from inside it.

## 3. Products

### `GET /products/browseProducts/getProducts` ✅
The product listing / search behind `/brskaj`.

| Query param | Example | Notes |
|---|---|---|
| `limit` | `100` | page size (100 works) |
| `offset`, `from` | `0`, `100`, … | pagination – send both, same value |
| `filterData[search]` | `toaletni papir` | free text; long names with `%` / sizes often return nothing – retry without them |
| `filterData[categories]` | `14535432` | category id (see `getCategories`, or `/brskaj#categories=<id>` links in the menu) |
| `filterData[discounts]` | `1,2,3,…,112` | only discounted products (ids from the page's discount groups, §3.3) |
| `_` | timestamp | cache buster, optional |

Response: `{ "products": [ … ] }` – entries with `type: "product"` (others are banners). Fields used:

```jsonc
{
  "type": "product",
  "itemId": "895195",
  "url": "/izdelek/895195/energijski-napitek-brez-sladkorja-red-bull-250-ml",
  "mainImageSrc": "https://mercatoronline.si/img/cache/products/…jpg",
  "data": {
    "name": "Energijski napitek, brez sladkorja, Red Bull, 250 ml",
    "current_price": "1.69",          // price you pay per piece – already includes straight and Pika discounts
    "normal_price": 0,                // regular price when discounted (0 = not discounted)
    "pc30_price": "0.00",             // lowest price in the last 30 days (EU price-indication rule)
    "price_per_unit": 6.76, "price_per_unit_base": "1l",   // also "1kg", "kos"
    "unit_quantity": "0.25", "invoice_unit": "Kos",
    "brand_name": "RED BULL",
    "gtins": [{ "gtin": "9002490200220" }],                 // needed for add-to-cart
    "category1": "PIJAČE", "category2": "…", "category3": "…",
    "package": 0,                     // >0 = "Kupi paket (N Kos)" offered
    "discounts": [ … ],               // §3.3
    "allergens": [ … ], "eko": "0", "rating": 0
  },
  "_meta": { "es_score": 1616.6 }     // search relevance
}
```

### `GET /products/categories/getCategories?parent_id=&categories=<id>` 👁
Category tree for the listing page. Menu links on every page also carry ids: `/brskaj#categories=14535432` (MLEKO).

### 3.3 Discounts (inside `data.discounts`) ✅
```jsonc
{ "group_type": "discount" | "pika_discount" | "action" | "other" | "web_shop" | "project",
  "value": "-38" | "1+1" | "2x" | "",
  "marker_code": "3", "discount_price": 1.85,
  "hover_text": "Ob nakupu 2 izdelkov ali več je vsak 50%",
  "coupon": "C-1KK6MA08",            // non-empty → needs a coupon
  "valid_from": "20261021232659", "valid_to": "20261101232659" }
```
Seen meanings: `value: "-NN"` straight / Pika % (already in `current_price`); `hover_text` "Ob nakupu N izdelkov ali več je vsak X%"
(quantity offer, **not** in `current_price`); `value: "1+1"` + "Ob nakupu 1 izdelka, vam enega podarimo" (one free).
Group ids from the page config: `gratis` 101,108,110,111 · `pika_discount` 104,105,106,112 · `posebna_ponudba` 2,5,10,126.
Parsed in `src/app/offers.ts`.

### `POST /products/products/getAjaxRelatedProducts` 👁
Recommendations on product pages ("crossale"/"upsale"). Not needed.

## 4. Cart (`/shop_cart/shop_cart/*`)

| Endpoint | Body | Status |
|---|---|---|
| `ajaxAddToCart` | `products[0][id]`, `products[0][quantity]`, `products[0][gtin]`, (`products[0][option]`), `analyticsListName`, `cartConf=default` | ✅ |
| `ajaxAddMultiplePositionsToCart` | `products[i][…]` (same fields, many lines), `analyticsListName`, `cartConf` | 👁 |
| `getCartInfo` | `cartConf=default` | ✅ |
| `ajaxChangeQantity` *(sic)* | `products[0][id]`, `[quantity]`, `[gtin]`, `[cartPositionID]`, `cartConf` | 👁 |
| `ajaxRemoveFromCart` | `products[0][id]`, `[quantity]`, `[gtin]`, `[cartPositionID]`, `cartConf` | 👁 |
| `resetCart` | `cartConf=default` – the site's "empty the cart" (after "Ali ste prepričani, da želite izprazniti košarico?") | 👁 |
| `checkCartStatus` | `cartConf` | 👁 |
| `changeProductOption` | `itemId`, `option`, `cartConf` | 👁 |
| `ajaxMergeCartNew` | – (merges an anonymous cart into the account after login) | 👁 |
| `/shop_cart/step_one/ajaxUpdateReplacable` | `values` – "may be replaced if out of stock" flags | 👁 |
| `/shop_cart/shop_cart/ajax_check_products_in_logistic_center` | `itemId`, `type`, `remove` – availability at the warehouse serving your address | 👁 (fired on checkout step 2) |

**`ajaxAddToCart` example ✅**
```
POST /shop_cart/shop_cart/ajaxAddToCart
products[0][id]=19148905&products[0][quantity]=1&products[0][gtin]=3838900802342&analyticsListName=Vsi+izdelki&cartConf=default
→ {"success":true,"minifiedShopCart":"<div class=\"hidden\"><span class=\"lib-cart-items-count\">4</span></div>…","analyticsObject":{…}}
```
`minifiedShopCart` is the mini-cart HTML; `lib-cart-items-count` = number of lines. The quantity-limit message
"Izdelek ni bil dodan v izbranem številu, ker je prišlo do kosovne omejitve." may appear when a limit applies.

**`getCartInfo` ✅** → `{"success":true,"numItems":4}` (cart **lines**, not pieces).

**`cartPositionID`** (for change/remove) isn't in search data – it has to be read from the cart page
(`/blagajna/pregled-kosarice`) or the mini-cart HTML. ❓ to capture.

## 5. Checkout

Pages: `/blagajna/pregled-kosarice` (1) → `/blagajna/izbira-prevzema` (2) → `/blagajna/izbira-placila` (3) →
`/blagajna/pregled-in-potrditev` (4). An order number (e.g. `1000003`) exists from step 4 on; it's only placed by step 4's submit.

### Step 2 – delivery
| Call | Details | Status |
|---|---|---|
| `POST /shop_cart/step_two/ajax_get_delivery_timetable` | `type` (`kliknadom` home / `klikindvig` pick-up), `addressId` **or** `logisticCenterId`, `fromDate`, `timetableModelName` (`radioTimetableDistributing` home / `radioTimetableReceiving` pick-up), `renderPath`, `selectedRangeDateTime` → `{success, timetableHtml}` | 👁 |
| timetable HTML | table: header = days ("Sobota 24. oktober"), rows = 2-hour slots 08–20, free cells = `<td>` with `input[type=radio]` (value `…#…`, attr `granulation`) + "Prosto" + delivery fee ("7,00 EUR"); taken = "Termin ni na voljo" | ✅ (read) |
| form `#deliveryDataForm` → `POST /shop_cart/step_two/validate_delivery_date` | `deliveryType` (`kliknadom`), the chosen `radioTimetableDistributing` value, `radioTimetableDistributingGranulation`, `deliveryAddressId`, … | ❓ exact fields |
| addresses | `ajax_add_delivery_address_data`, `ajax_save_delivery_address_data`, `ajax_delete_delivery_address` | 👁 (not needed) |

Delivery fees (from `/cenik-dostave`): over 60 € free · 30–60 € 5 € · under 30 € 7 € (promotions can lower the threshold).
Slots Mon–Sat until 20:00.

### Step 3 – payment: form → `POST /blagajna/shrani-placila` ✅ (fields read)
| Field | Values |
|---|---|
| `fixedPayment` | `mastercard`, `visa`, `diners`, `moneta` (pay now → Bankart gateway, SCA) · **`offlineCash`**, **`offlineCard`** (pay on delivery) |
| `storeCredit` | amount of "dobroimetje" to use |
| `pikaGift[i][value]`, `pikaGift[i][cardNum]` | gift cards |

### Step 4 – review & confirm: form → `POST /blagajna/potrdi-narocilo` ✅ (fields read, never submitted by us)
| Field | Value |
|---|---|
| `note` | note for the driver (optional) |
| `confirm-terms` | `on` – "Strinjam se s pogoji poslovanja" |

The page text holds the summary: "naročila št.<nr>", products, "Datum in čas dostave", "Izbrani načini plačila",
"Vrednost izdelkov", "Cena dostave", "Skupaj za plačilo" (parsed by `parseReview` in `src/shop/checkout.ts`).
**Placing an order = this POST.** Only ever after the user's explicit OK.

## 6. Account pages (HTML, parsed in `src/shop/pages.ts`) ✅

| Page | Content |
|---|---|
| `/uporabnik/pretekli-nakupi` | "Moja naročila": table `.table-seznam-narocil` – number, status ("Potrjeno"), date+time, delivery type, amount paid, link "Prikaži". All orders on one page (50+ seen, no paging). |
| `/uporabnik/podrobnosti-narocila/<nr>` | order: per line name (`td.td-name`), status (`IZDOBAVLJENO`), ordered qty, delivered qty, price per piece, line total; summary incl. "Vrednost izdelkov", "Čas dostave … med 16:00 in 18:00", payment, address. |
| `/uporabnik/moj-racun`, `/naslovi-dostave`, `/dobroimetje`, `/nakupovalni-listki`, `/obvescanje`, `/primerjalnik-izdelkov` | account menu (not used) |

## 7. Other public pages
`/cenik-dostave` (delivery prices) · `/pogosta-vprasanja` (FAQ) · `/preverita-ali-dostavljamo-v-vas-kraj` · `/akcijski-katalogi`.

---

## Still to capture (one recorded checkout, stopping before step 4's submit)
1. Exact body of step 2's submit (`validate_delivery_date`) and the slot radio value format.
2. Request/response of `ajax_get_delivery_timetable` (`fromDate` format, `renderPath`).
3. Exact body of step 3's submit (`shrani-placila`) – hidden fields besides `fixedPayment`.
4. `cartPositionID` source, and responses of `ajaxChangeQantity` / `ajaxRemoveFromCart` / `ajaxAddMultiplePositionsToCart`.
