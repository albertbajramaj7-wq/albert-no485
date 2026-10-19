from pathlib import Path
import re,html,json
ROOT=Path(__file__).resolve().parents[1];DIST=ROOT/'public';SRC=ROOT/'site'
home=(SRC/'home.html').read_text()
basecss=re.search(r'<style>(.*?)</style>',home,re.S).group(1)
(DIST/'assets/site.css').write_text(basecss+'\n'+(SRC/'pages.css').read_text())
shared_js=(SRC/'site.js').read_text()
(DIST/'assets/site.js').write_text(shared_js)
(DIST/'assets').mkdir(parents=True,exist_ok=True)
for name in ['admin.css','admin.js','booking.js']:
 (DIST/'assets'/name).write_text((SRC/name).read_text())
admin_folder=DIST/'admin';admin_folder.mkdir(exist_ok=True)
(admin_folder/'index.html').write_text((SRC/'admin.html').read_text())
(admin_folder/'manifest.webmanifest').write_text((SRC/'admin.webmanifest').read_text())

def links(s):
 for a,b in [('https://www.albertno485.com/meny','/meny/'),('https://www.albertno485.com/historien','/historien/'),('https://www.albertno485.com/avpn','/avpn/'),('https://www.albertno485.com/boka-pizza','/boka-pizza/')]:s=s.replace(a,b)
 s=s.replace('src="assets/','src="/assets/').replace('href="assets/','href="/assets/')
 return s
header=links(re.search(r'<header>.*?</header>',home,re.S).group())
header=header.replace('href="#"','href="/"').replace('href="#meny"','href="/meny/"').replace('href="#historia"','href="/historien/"').replace('href="#hantverk">Hantverket','href="/avpn/">AVPN').replace('href="#besok"','href="/#besok"')
footer=links(re.search(r'<footer>.*?</footer>',home,re.S).group())
footer=footer.replace('href="#" class="logo"','href="/" class="logo"').replace('href="#meny"','href="/meny/"').replace('href="#historia"','href="/historien/"').replace('href="#hantverk">Hantverket','href="/avpn/">AVPN').replace('href="#besok"','href="/#besok"')
footer=footer.replace('href="#">Till toppen','href="#main">Till toppen')
footer=footer.replace('<span>Vera Pizza Napoletana · N° 1232</span>','<span>Vera Pizza Napoletana · N° 1232</span><a href="/integritet/">Integritetspolicy</a>',1)
footer=footer.replace('href="https://www.albertno485.com/admin"','href="/admin/"')

def render(slug,title,description,body,extra_class='',scripts=''):
 current=header.replace('href="/'+slug+'/"','href="/'+slug+'/" aria-current="page"',1)
 content=f'''<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#23261f"><meta name="description" content="{html.escape(description,quote=True)}"><title>{html.escape(title)} | Albert NO.485</title><link rel="stylesheet" href="/assets/site.css"><script src="/assets/site.js" defer></script>{scripts}</head><body class="subpage {extra_class}"><a class="skip" href="#main">Till innehållet</a>{current}<main id="main">{body}</main>{footer}<a class="mobile-book" href="/boka-pizza/"><span>Boka din pizza</span></a></body></html>'''
 folder=DIST/slug;folder.mkdir(exist_ok=True);(folder/'index.html').write_text(content)

def crumb(label):return f'<div class="breadcrumbs"><a href="/">Start</a><span aria-hidden="true">/</span><span>{label}</span></div>'
def intro(label,kicker,title,text,image,alt,caption='',extra=''):
 return f'<section class="page-intro {extra}"><div class="container">{crumb(label)}<div class="page-intro-grid"><div><div class="small">{kicker}</div><h1 class="page-title">{title}</h1><p class="page-lead">{text}</p></div><div class="intro-visual"><img src="/assets/{image}" alt="{alt}" fetchpriority="high">'+(f'<span class="photo-label">{caption}</span>' if caption else '')+'</div></div></div></section>'
def cta(kicker,title,text=''):
 return f'<section class="page-cta"><div class="container cta-flex"><div><div class="small">{kicker}</div><h2>{title}</h2>'+ (f'<p>{text}</p>' if text else '')+'<div></div></div><a class="pill" href="/boka-pizza/">Boka din pizza</a></div></section>'
# Fix the action placement in the common CTA.
def cta(kicker,title,text=''):
 return f'<section class="page-cta"><div class="container cta-flex"><div><div class="small">{kicker}</div><h2>{title}</h2>'+ (f'<p>{text}</p>' if text else '')+'</div><a class="pill" href="/boka-pizza/">Boka din pizza</a></div></section>'
pizzas=[('Marinara',145,'San Marzano tomatsås, finskivad vitlök, torkad oregano, basilikablad och olivolja.'),('Margherita',155,'San Marzano tomatsås, mozzarella, basilikablad, pecorino och olivolja.'),('Diavola',165,'San Marzano tomatsås, salami, mozzarella, lagrad ost, oregano och basilikablad.'),('Prosciutto e Pomodorino',175,'San Marzano tomatsås, körsbärstomater, mozzarella, lufttorkad skinka, rucola, parmesan och olivolja.'),('Bosco',165,'Mozzarella, skogschampinjoner, körsbärstomat, rucola, parmesan och olivolja.')]
dolce=[('Tiramisu',60,'Fråga oss om dagens tillgång. Begränsat antal.'),('Espresso',35,'En liten kopp efter maten, eller bara för att.')]
def dishes(items):return ''.join(f'<article class="dish"><div class="dish-top"><h3>{n}</h3><span class="price">{p} kr</span></div><p>{d}</p></article>' for n,p,d in items)
menu=intro('Meny','Från vår ugn','Vad blir<br><em>din pizza?</em>','Napolitanska klassiker och våra egna favoriter. Välj pizza när du kommer, så tar vi hand om resten vid ugnen.','bordet.jpeg','En av våra pizzor serverad på bordet','Vedeldat · Format för hand')
menu+='''<section class="menu-full"><div class="container"><div class="menu-controls"><div class="menu-filters" role="group" aria-label="Visa menykategori"><button type="button" data-menu-filter="all" aria-pressed="true">Hela menyn</button><button type="button" data-menu-filter="pizza" aria-pressed="false">Pizza</button><button type="button" data-menu-filter="dolce" aria-pressed="false">Dolce & caffè</button></div><button class="menu-print" type="button" id="print-menu">Skriv ut menyn</button></div><p class="print-label">Albert NO.485 · Pilgatan 3, Varberg · 0340–827 75</p>'''
menu+='<section class="menu-category" data-menu-category="pizza"><div class="small">Pizza Napoletana</div><h2>Från ugnen.</h2><div class="full-menu-grid">'+dishes(pizzas)+'</div></section>'
menu+='<section class="menu-category" data-menu-category="dolce"><div class="small">Dolce & caffè</div><h2>Något efteråt.</h2><div class="full-menu-grid">'+dishes(dolce)+'</div></section>'
menu+='''<div class="allergen-box"><div><p>Alla priser är i svenska kronor inklusive moms.</p><p>Har du en allergi? Prata med oss innan du beställer, så går vi igenom ingredienser och hantering tillsammans. Tiramisu finns i begränsat antal och utbudet kan variera.</p></div><div class="menu-contact"><span>Fråga oss om maten</span><a href="tel:+4634082775">0340–827 75</a></div></div></div></section>'''+cta('En plats i ugnen','Hittat din favorit?','Boka antal pizzor och en färdigtid. Du väljer pizza och betalar på plats.')
render('meny','Meny','Se pizzorna, ingredienserna och priserna hos Albert NO.485. Espresso 35 kr och tiramisu 60 kr.',menu,'menu-page')

story=intro('Vår historia','Hej, jag är Albert.','Det började<br><em>med farsan.</em>','En pizzeria i Trönninge. Tiden tillsammans med pappa. Provdegarna som blev allt fler. Det här är vägen till Albert NO.485.','hantverk.jpeg','Albert arbetar med degen vid pizzabänken','Varberg · Vårt hantverk i dag')
story+='<nav class="chapter-nav" aria-label="Historiens kapitel"><div class="container"><a href="#kapitel-2008">2008 / Början</a><a href="#kapitel-2017">2017 / Tillsammans</a><a href="#kapitel-2024">2024 / Företaget</a><a href="#kapitel-2025">2025 / Neapel</a><a href="#kapitel-2026">2026 / AVPN</a></div></nav>'
def chapter(year,kicker,title,paras,id):
 return f'<article class="chapter" id="kapitel-{id}"><div class="chapter-year">{year}</div><div><div class="small">{kicker}</div><h2>{title}</h2>'+''.join('<p>'+p+'</p>' for p in paras)+'</div></article>'
story+='<div class="chapters">'+chapter('2008','Första kapitlet','En lucka i Trönninge.',['Min pappa öppnar Trönninge Pizza. Det börjar i liten skala, med försäljning genom en lucka i väggen. Där tar historien sin början, långt innan namnet Albert NO.485 finns.','När jag tänker på hur allt började är det människorna jag kommer tillbaka till. Farsan och pizzerian. Det är grunden till det vi gör i dag.'],'2008')+chapter('2017','Tiden tillsammans','Jag kliver in.',['Jag börjar arbeta med farsan. Den första anledningen är enkel: jag vill få mer tid med honom. Vi får en vardag tillsammans, med pizzerian som mötesplats.','Under arbetet växer mitt eget intresse för pizza. Jag börjar vilja förstå mer om det vi gör och hur pizzan kan utvecklas. Det som började med tid tillsammans blir också början på något eget.'],'2017')+'</div>'
story+='<blockquote class="pullquote">Det började med att jag ville<br>ha mer tid med farsan.</blockquote><figure class="wide-photo"><img src="/assets/preparation.jpeg" alt="Arbetet med pizzan vid bänken hos Albert" loading="lazy"><figcaption>Vid pizzabänken. Här fortsätter historien varje dag.</figcaption></figure>'
story+='<div class="chapters">'+chapter('2023–2024','Provdegarna','Fler försök. En egen riktning.',['Intresset blir till provdegar och nya försök. Jag testar, justerar och börjar om. Det går inte att förstå en deg enbart genom att läsa om den; jag behöver arbeta med den.','I september 2024 startar jag mitt eget företag. Experimenten är inte längre bara ett intresse vid sidan av. Jag vill fortsätta utveckla pizzan och se hur långt jag kan ta hantverket.'],'2024')+chapter('2025','Resan till Neapel','Där blir riktningen tydlig.',['I april reser jag till Neapel. Det blir en viktig del av min egen resa med pizzan. Här får jag en tydligare bild av vad jag vill göra hemma i Varberg.','Riktningen blir napolitansk pizza, en vedeldad ugn och ett nytt namn: Albert NO.485. Ugnen från Stefano Ferrara blir en del av arbetet på Pilgatan.','Det handlar fortfarande om samma sak som vid de första provdegarna: att fortsätta lära mig och göra nästa pizza bättre.'],'2025')+'</div>'
story+='<section class="cert-feature" id="kapitel-2026"><div class="container cert-feature-grid"><img src="/assets/diplome.jpeg" alt="AVPN-diplomet på väggen hos Albert NO.485" loading="lazy"><div><div class="small">2026 / Ett nytt kapitel</div><h2>En del av den<br>napolitanska traditionen.</h2><p>Under februari blir Albert NO.485 medlem i Associazione Verace Pizza Napoletana, med medlemsnummer 1232.</p><p>Certifieringen är ett viktigt steg i resan. Men arbetet fortsätter på samma plats som tidigare: vid degen, bänken och ugnen. Det är där jag fortfarande står.</p><a class="arrow-link" href="/avpn/">Läs om vårt hantverk och AVPN</a></div></div></section>'
story+=cta('Historien fortsätter','Kom förbi och säg hej.','En plats vid bordet, en pizza från ugnen och lite tid tillsammans. Vi ses på Pilgatan 3.')
render('historien','Vår historia','Från farsans pizzeria i Trönninge 2008 till Albert NO.485, Neapel och AVPN-certifieringen i Varberg.',story,'story-page')

avpn=intro('AVPN','Vera Pizza Napoletana · N° 1232','Rötterna<br><em>i Neapel.</em>','Albert NO.485 är certifierat av Associazione Verace Pizza Napoletana. En napolitansk tradition som vi för vidare vid bänken och ugnen, här i Varberg.','diplome.jpeg','Vårt AVPN-diplom på väggen i restaurangen','Albert NO.485 · Medlem 1232')
avpn+='''<section class="avpn-details"><div class="container principles"><article><div class="small accent">01 / Händerna</div><h2>Formad för hand.</h2><p>Vi öppnar degen med händerna. Arbetet vid bänken är en del av det napolitanska hantverket och av hur vi gör vår pizza.</p></article><article><div class="small accent">02 / Ugnen</div><h2>Vedeldat, på riktigt.</h2><p>Vår vedeldade ugn kommer från Stefano Ferrara i Italien. Det är här degen blir en pizza och får sin gräddning.</p></article><article><div class="small accent">03 / På tallriken</div><h2>Pizza Napoletana.</h2><p>Mjuk i mitten och luftig i kanten. Ät pizzan medan den är varm och låt stunden vid bordet få ta sin tid.</p></article></div></section>'''
avpn+='''<section><div class="container avpn-explained"><div><div class="small">Om certifieringen</div><h2>Vad betyder<br>egentligen AVPN?</h2><img class="avpn-original" src="/assets/avpn-transparent.webp" alt="Officiell logga för Vera Pizza Napoletana" width="450" height="243" loading="lazy"></div><div><p>Associazione Verace Pizza Napoletana grundades i Neapel 1984 för att bevara och föra vidare traditionen kring den napolitanska pizzan.</p><p>Föreningens certifiering gäller sättet pizzan görs på. För oss betyder det att hantverket inte stannar vid ett diplom på väggen. Det hör ihop med hur vi arbetar med degen och bakar pizzorna varje dag.</p><p>Albert NO.485 finns med i AVPN:s officiella register. Där kan du se vår restaurang och vårt medlemsnummer.</p><div class="avpn-registration"><dl><div><dt>Restaurang</dt><dd>Albert NO.485</dd></div><div><dt>Medlemsnummer</dt><dd>1232</dd></div><div><dt>Plats</dt><dd>Varberg, Sverige</dd></div></dl><a class="arrow-link" href="https://www.pizzanapoletana.org/en/associati/1573-albert_no485" target="_blank" rel="noopener">Se oss i AVPN:s register</a></div></div></div></section>'''
avpn+='<figure class="wide-photo"><img src="/assets/hantverk.jpeg" alt="Pizzadegen formas för hand hos Albert" loading="lazy"><figcaption>Traditionen blir till i händerna.</figcaption></figure>'+cta('Hantverket har en historia','Möt Albert vid ugnen.','Boka en tid och kom förbi. Vill du läsa mer om resan hit hittar du den under Vår historia.')
render('avpn','AVPN-certifierad · Nr 1232','Vera Pizza Napoletana i Varberg. Läs om Albert NO.485:s AVPN-certifiering, medlemsnummer 1232 och vedeldade hantverk.',avpn,'avpn-page')

# Integritetspolicy (GDPR). Uppdatera bolagsnamn/org.nr i FORETAG nedan.
FORETAG = 'Albert NO.485'
ORGNR = ''
legal = f'<section class="legal"><div class="container legal-inner">{crumb("Integritetspolicy")}<div class="small">Senast uppdaterad 19 oktober 2026</div><h1 class="page-title">Integritets&shy;policy</h1>'
legal += '<p class="page-lead">Så här hanterar vi dina personuppgifter när du bokar hos oss. Kort sagt: vi sparar bara det som behövs för din bokning, vi säljer aldrig uppgifter, och vi tar bort dem automatiskt efter ett år.</p>'
def sec(title, body): return f'<h2>{title}</h2>{body}'
legal += sec('Vem ansvarar för dina uppgifter?', f'<p>Personuppgiftsansvarig är {FORETAG}{", org.nr " + ORGNR if ORGNR else ""}, Pilgatan 3, Varberg. Kontakta oss på telefon <a href="tel:+46340-82775">0340–827 75</a> eller besök oss i restaurangen om du har frågor om dina uppgifter.</p>')
legal += sec('Vilka uppgifter sparar vi?', '<ul><li>Namn, telefonnummer och e-postadress som du fyller i när du bokar.</li><li>Uppgifter om bokningen: datum, tid, antal pizzor, antal gäster och om du äter här eller tar med.</li><li>Om bokningen ändras eller avbokas sparar vi det, och eventuellt en kort anledning.</li></ul><p>Vi sparar inga betalkortsuppgifter, och hemsidan använder inga spårnings- eller reklamcookies.</p>')
legal += sec('Varför sparar vi dem?', '<ul><li>För att kunna ta emot och genomföra din bokning (avtal).</li><li>För att skicka en bokningsbekräftelse till din e-post.</li><li>För att kunna kontakta dig om något ändras, till exempel om vi måste stänga.</li></ul><p>Vi skickar inga nyhetsbrev eller reklam utan att du uttryckligen har bett om det.</p>')
legal += sec('Hur länge sparas de?', '<p>Namn, telefonnummer och e-post tas bort automatiskt <strong>12 månader</strong> efter bokningsdagen. Kvar blir bara anonyma siffror, till exempel hur många pizzor som bokades en viss dag, som vi använder för att planera verksamheten.</p>')
legal += sec('Vem får ta del av uppgifterna?', '<p>Bara vi som arbetar i restaurangen och behöver dem. Vi använder några tjänsteleverantörer som behandlar uppgifterna för vår räkning och enligt avtal:</p><ul><li><strong>Supabase</strong>, databas där bokningarna lagras.</li><li><strong>Vercel</strong>, drift av hemsidan.</li><li><strong>Resend</strong>, utskick av bokningsbekräftelser (skickas från EU).</li></ul><p>Om en leverantör behandlar uppgifter utanför EU/EES sker det med stöd av EU-kommissionens standardavtalsklausuler eller motsvarande skydd. Vi säljer aldrig dina uppgifter.</p>')
legal += sec('Dina rättigheter', '<p>Du har rätt att få veta vilka uppgifter vi har om dig, att få fel rättade och att få dina uppgifter raderade i förtid. Du kan också invända mot behandlingen. Ring oss på 0340–827 75 så hjälper vi dig.</p><p>Tycker du att vi hanterar dina uppgifter fel kan du lämna klagomål till <a href="https://www.imy.se" rel="noopener">Integritetsskyddsmyndigheten (IMY)</a>.</p>')
legal += '</div></section>'
render('integritet','Integritetspolicy','Så hanterar Albert NO.485 dina personuppgifter när du bokar: vad vi sparar, varför, hur länge och dina rättigheter.',legal,'legal-page')

# Keep the approved homepage; route every complete page within the new site.
h=links(home)
h=re.sub(r'<style>.*?</style>','<link rel="stylesheet" href="/assets/site.css">',h,flags=re.S)
h=re.sub(r'<script>.*?</script>','<script src="/assets/site.js" defer></script>',h,flags=re.S)
h=re.sub(r'<header>.*?</header>',header,h,flags=re.S)
h=re.sub(r'<footer>.*?</footer>',footer,h,flags=re.S)
h=h.replace('vår befintliga bokningssida','vår bokningssida')
(DIST/'index.html').write_text(h)
# Booking content is a separate maintained template.
booking=(SRC/'booking.html').read_text()
render('boka-pizza','Boka pizza','Boka antal pizzor och färdigtid hos Albert NO.485 i Varberg. Ät här eller ta med, välj pizza och betala på plats.',booking,'booking-page',scripts='<script src="/assets/booking.js" defer></script>')
print('Built home, menu, story, AVPN, booking and admin pages.')
