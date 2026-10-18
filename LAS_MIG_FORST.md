# Albert NO.485 – webbplatsens källkod

Det här är källkoden till webbplatsen som publicerades på:
https://albert-no485-forsta-version.albert-bajra-6117.chatgpt.site

Version: 9
Källkodsrevision: 4b335926542a77623e9d04059eb23c15058a5cda
Exporterad: 18 oktober 2026.

## Här finns själva webbplatsen

- `public/index.html` – startsidan.
- `public/meny/index.html` – menyn.
- `public/historien/index.html` – vår historia.
- `public/avpn/index.html` – AVPN-sidan.
- `public/boka-pizza/index.html` – bokningssidan.
- `public/admin/index.html` – den fristående adminen.
- `public/assets/` – CSS, JavaScript, samtliga lokala bilder och de transparenta loggorna.

## Här ändrar du koden

- `src/` innehåller de underhållna HTML-mallarna, CSS- och JavaScript-filerna.
- `src/build_pages.py` genererar filerna i `public/` från mallarna.
- `app/` innehåller sidhantering, API-anrop, layout och autentisering.
- `lib/` innehåller bokningslogik, kapacitetskontroller, adminfunktioner och bekräftelsemejl.
- `components/` och `hooks/` innehåller React-komponenter och hjälpkod.
- `build/`, `scripts/`, `vendor/` och konfigurationsfilerna följer med för att behålla projektets byggmiljö.
- `tests/` innehåller projektets funktionstester.
- `db/` innehåller databasmodellernas TypeScript-källkod; inga databasexporter ingår.

## Förhandsvisa sidornas utseende

Servera `public/` som webbrot. Om Python finns installerat kan du köra följande från projektmappen:

    python -m http.server 8000 --directory public

Öppna sedan http://localhost:8000/ i en webbläsare. Använd en lokal webbserver eftersom tillgångarnas sökvägar börjar med `/assets/`.

Den statiska förhandsvisningen visar sidornas HTML, CSS, JavaScript och bilder. Riktiga bokningar, sparande i admin och mejlutskick kräver projektets serverdel och rätt konfiguration.

Efter ändringar i mallarna:

    python src/build_pages.py

## Server och inställningar

Den publicerade servern använder Vinext/Cloudflare, D1 och ChatGPT-inloggning. Det här är originalkällkoden, inte en färdig integration för en annan värdtjänst. Byggkommandon och beroenden finns i `package.json`, med låsta beroenden i `pnpm-lock.yaml`. Fullständig serverdrift behöver motsvarande miljö och databas.

Bokningsbekräftelser via Resend finns implementerade men var inte aktiverade vid exporten. `.env.example` visar inställningarnas namn och har inga hemliga värden.

## Avsiktligt utelämnat

`schema.sql`, andra SQL-filer, SQL-migrationer och migrationsmetadata ingår inte. Det finns inga kundregister, bokningsdata, API-nycklar, lösenord, installerade beroenden, temporära filer eller Git-historik i zip-filen. Databastesterna behöver ett separat databasupplägg innan de kan köras.

`README.md` är projektets ursprungliga utvecklardokumentation och följer med som referens. Hänvisningar där till SQL-migrationer gäller originalprojektet; SQL-filerna är utelämnade i denna leverans.
