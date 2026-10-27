# Albert NO.485 – ny version på Supabase och Vercel

Den här mappen (`web/`) är den nya versionen av hemsidan och adminsystemet.
ChatGPT:s originalkod ligger kvar orörd i projektets rotmapp. Inget där är
ändrat eller borttaget. Den gamla koden kan städas bort senare, men bara
när Albert har godkänt det.

## Vad som finns här

| Mapp / fil | Innehåll |
|---|---|
| `public/` | Själva hemsidan: startsida, meny, historia, AVPN, bokning och admin. Samma design, bilder och texter som ChatGPT:s version. |
| `site/` | Källfilerna för sidorna. Efter ändringar körs `python3 site/build_pages.py`, som skriver om `public/`. |
| `api/router.js` | Serverfunktionen på Vercel. Tar emot alla anrop till `/api/...`. |
| `lib/` | Serverkoden: anrop till databasen och inloggningen, bekräftelsemejl. Inga externa paket. |
| `supabase/migrations/` | Databasen: tabeller, regler och all bokningslogik. |
| `tests/` | 27 automatiska tester som körs mot en riktig Postgres-databas. |
| `.env.example` | Namnen på de inställningar som behöver läggas in i Vercel. |

## Vad som är nytt jämfört med ChatGPT:s version

- **Egen inloggning** med e-post och lösenord via Supabase, i stället för ChatGPT-konto.
- **Roller:** ägare, administratör och personal. Personal ser dagsvy, arbetsuppgifter och historik.
  Administratörer ser också statistik, meny, personal och inställningar.
- **Svinn med orsak:** bränd, degen sprack, tappad, fel beställning, reklamation eller övrigt.
  En registrering kan makuleras men raderas aldrig.
- **Statistik** för 7, 30 eller 90 dagar: pizzor, drop-in, svinn, gäster och uppskattad försäljning.
- **Menyn** kan ändras i admin och syns direkt på menysidan.
- **Inställningar:** öppna dagar, tider, kapacitet och stängda datum (jul, semester, privata evenemang).
- **Personal:** lägg till personer, byt roll, inaktivera, sätt nytt tillfälligt lösenord. Förberett för BankID.

Allt från ChatGPT:s version finns kvar: pizzabaserad bokning (8 per kvart, 31 per timme, 31 platser),
skydd mot dubbelbokning, dagens pizzantal, drop-in, arbetsuppgifter, historik, CSV-export och bekräftelsemejl.

## Så sätter du upp det (en gång)

### 1. Supabase (databas och inloggning)
1. Skapa ett projekt på supabase.com. Välj en region i EU, till exempel Stockholm (eu-north-1).
2. Öppna **SQL Editor**, klistra in hela filen `supabase/migrations/0001_albert_core.sql` och kör den.
3. Gå till **Authentication → Sign In / Providers** och stäng av **Allow new users to sign up**.
   Bara konton som skapas från admin ska kunna logga in.
4. Gå till **Authentication → Users → Add user** och skapa ditt eget konto (din e-post och ett starkt lösenord).
   Kryssa i att e-posten är bekräftad.
5. Gå till **Project Settings → API** och kopiera *Project URL*, *anon key* och *service_role key*.

### 2. Vercel (publicering)
1. På vercel.com: **Add New → Project** och välj GitHub-repot `albert-no485`.
2. Sätt **Root Directory** till `web` och **Framework Preset** till *Other*.
3. Under **Environment Variables**, lägg in:
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_ANON_KEY` = anon key
   - `SUPABASE_SERVICE_ROLE_KEY` = service_role key (hemlig, får bara finnas här)
   - `ADMIN_OWNER_EMAIL` = din e-post från steg 1.4
   - `APP_ORIGIN` = hemsidans adress, till exempel `https://www.albertno485.com` (när domänen är flyttad)
4. Klicka **Deploy**. Du får en testadress som slutar på `.vercel.app`.

### 3. Skydd mot överbelastning (rekommenderas)
Slå på Vercel Firewall och lägg en begränsning (rate limit) på `/api/auth/login` och `/api/bookings`,
till exempel 10 anrop per minut per IP-adress. Databasen stoppar redan fler än 3 bokningar per gäst och dag.

### 4. Testa
1. Öppna testadressen och gör en provbokning.
2. Gå till `/admin/` och logga in. Första gången blir ditt konto ägarkonto.
3. Lägg till personal under **Personal** och prova att logga in som dem.

### 5. Byta till albertno485.com (senare, efter ditt godkännande)
Domänen pekar fortfarande på Wix. Den flyttas först när allt är testat och du har sagt ja.
Innan dess behöver vi gå igenom bokningar som redan finns i Wix, så att ingen gäst tappas bort.

## Bekräftelsemejl (valfritt)
Fungerar som i ChatGPT:s version via Resend. Lägg in `RESEND_API_KEY`, `BOOKING_EMAIL_FROM`
och eventuellt `BOOKING_EMAIL_REPLY_TO` i Vercel. Utan dem sparas bokningar som vanligt,
och gästen ser sin bekräftelse på skärmen.

## Veckobudget och Fortnox
1. Kör `supabase/migrations/0003_veckobudget.sql` och `0004_fortnox.sql` i Supabase SQL Editor (i den ordningen).
2. Skapa en integration i Fortnox utvecklarportal med behörigheterna Bookkeeping, Supplier,
   Supplier Invoice, Article och Company Information. Redirect URI: `https://<din-adress>/api/fortnox/callback`.
3. Lägg in `FORTNOX_CLIENT_ID` och `FORTNOX_CLIENT_SECRET` i Vercel. Valfritt: `CRON_SECRET`
   (hämtning varje natt kl 03 UTC) och `FORTNOX_REDIRECT_URI` om adressen ska vara fast.
4. Kör även `0007_fortnox_ekonomi.sql` (ekonomiöversikt). Kundfakturor: bocka i Faktura i portalen,
   sätt `FORTNOX_EXTRA_SCOPES=invoice` i Vercel och koppla om.
5. Admin → Veckobudget → Koppla Fortnox. Admin → Ekonomi visar saldon, resultat och obetalda fakturor. Admin läser bara från Fortnox; inget bokförs eller skickas.

## AI-assistent
Admin → AI-assistent. Kräver `ANTHROPIC_API_KEY` i Vercel (skapas på console.anthropic.com, sätt en
månadsgräns där). Valfritt `ANTHROPIC_MODEL` (standard: claude-sonnet-5-5). Assistenten läser bara
sammanställd data via verktyg i `lib/ai.js` – inga gästuppgifter skickas och den kan inte ändra något.

## Integritet, spärrar och säkerhetskopior
- Kör `0006_integritet_skydd.sql`. Bokningar äldre än `retention_days` (standard 365) anonymiseras
  automatiskt varje natt och när admin öppnas (högst en gång per dygn).
- Spärr: högst 8 bokningsförsök och 10 inloggningsförsök per 10 minuter per avsändare (bara en hash
  av IP-adressen sparas, rensas efter ett dygn).
- Nattjobbet `/api/cron/nightly` kräver `CRON_SECRET` i Vercel.
- Säkerhetskopia: `.github/workflows/backup.yml` (aktiveras när den finns på `main`). Kräver
  `SUPABASE_DB_URL` och `BACKUP_PASSPHRASE` som GitHub Actions-hemligheter.
- Integritetspolicy: `/integritet/`. Visar "Albert NO.485", adress och telefon (bolagsnamn och org.nr visas inte, enligt Albert).

## Ekonomi & Bank (Danske Bank, endast läsning)

Saldo, transaktioner, kassaflödesprognos (7/14/30 dagar), matchning mot Fortnox och AI-frågor.
Banken kan aldrig ändras härifrån: koden släpper bara igenom läsningar som står på en lista
(lista konton, saldo, transaktioner) och banken ger bara behörigheten `accounts`.

**Vem ser det:** ägaren. Administratörer bara om ägaren bockar i dem under Ekonomi & Bank → Behörighet. Personal aldrig.

**Miljöer** (inställningen `DANSKE_ENV` i Vercel):
- Inte satt: förhandsvisningen använder bankens testdata (mock), riktiga sidan är avstängd.
- `sandbox`: bankens testmiljö. Kräver nycklarna nedan.
- `live`: riktiga bankdata. Kräver nycklarna nedan **och** `DANSKE_LIVE_ENABLED=ja`.
Test- och riktiga data sparas åtskilda och blandas aldrig.

**Det här behöver ordnas med Danske Bank innan riktiga data:**
1. District-avtal för företaget (eller utökning av befintligt) som omfattar Premium API.
2. Registrering på bankens API-plattform och abonnemang på *Account Transaction & Balance API*.
3. Ett digitalt certifikat (klientcertifikat) registrerat hos banken, plus ett Client ID.
4. Bekräftelse från banken att API:et gäller företagets svenska konton.
5. En teknisk användare med läsbehörighet (enquiry) till rätt konton – inga betalningsbehörigheter.

**Lägg in i Vercel (aldrig i chatten):** `DANSKE_CLIENT_ID`, `DANSKE_CLIENT_CERT_PEM`, `DANSKE_CLIENT_KEY_PEM`,
eventuellt `DANSKE_CLIENT_KEY_PASSPHRASE`. Certifikat och nyckel kan klistras in som PEM-text eller base64.

Banken hämtas automatiskt varje natt och med knappen "Hämta från banken". Varje hämtning och läsning loggas
(utan nycklar) och syns under Behörighet → Åtkomstlogg.

Obs: när du ställer en bankfråga till AI-assistenten skickas sammanställd bankdata (belopp, motparter, kategorier) till Anthropic för att besvara frågan. Assistenten kan bara läsa. Bankbehörigheten tas automatiskt bort om en person byter roll eller inaktiveras.

## För utvecklare
- Testerna kräver en lokal Postgres (`psql` i PATH): `PGHOST=... PGPORT=... PGUSER=... npm test`
- Lokal förhandsvisning med låtsas-inloggning: `node tests/dev-server.mjs`, öppna http://localhost:8787
  (logga in med `albert@albertno485.com` / `lokal-test-123`).
- All bokningslogik ligger i databasfunktionerna `api_*`. Bara servern får anropa dem.
  Tabellerna har RLS påslaget utan öppna regler, så Supabase publika nyckel kommer inte åt någon data.


