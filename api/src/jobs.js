// Job fetching shared by the Azure Function (api/src/functions/jobs.js) and the local Express server (server.js).
import * as cheerio from "cheerio";

const TESCO_ORIGIN = "https://apply.tesco-careers.com";
const SCREWFIX_ORIGIN = "https://jobs.screwfix.com";
const LIDL_ORIGIN = "https://careers.lidl.co.uk";
const TOWNS = ["Horsham", "Crawley", "Billingshurst"];

const clean = (v = "") => v.replace(/\s+/g, " ").trim();
function absoluteUrl(href, origin) { try { return href ? new URL(href, origin).href : null; } catch { return null; } }
async function fetchHtml(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; LocalJobsViewer/1.1; personal job search)", Accept: "text/html,application/xhtml+xml" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${r.status}`);
  return r.text();
}

function parseTesco(html) {
  const $ = cheerio.load(html), jobs = [], seen = new Set();
  $("h2, h3, h4").each((_, heading) => {
    const $h = $(heading), $a = $h.find("a[href]").first().length ? $h.find("a[href]").first() : $h.closest("a[href]");
    if (!$a.length) return;
    const title = clean($a.text()), url = absoluteUrl($a.attr("href"), TESCO_ORIGIN);
    if (!title || !url || seen.has(url) || !/job|career|vacan|position/i.test(url)) return;
    let $card = $h.parent();
    for (let i=0;i<5 && $card.parent().length;i++) { const t=clean($card.text()); if(t.length>=title.length+10 && /permanent|temporary|fixed term|competitive|£|apply by|in \d+ days?/i.test(t)) break; $card=$card.parent(); }
    const rest=clean(clean($card.text()).replace(title,""));
    const date=rest.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s*\([^)]*\))?/), contract=rest.match(/\b(Permanent|Temporary|Fixed Term|Part[- ]?time|Full[- ]?time)\b/i), salary=rest.match(/(£[\d,.]+(?:\s*(?:Per Hour|per hour|Pro Rata))?|Competitive[^,]*)/i);
    let location=rest; for(const m of [contract?.[0],salary?.[0],date?.[0]]) if(m) location=clean(location.replace(m,""));
    jobs.push({ company:"Tesco", title, location:location.replace(/\([^)]*\)/g,"").trim()||"Billingshurst", contract:contract?.[0]||null, salary:salary?.[0]||null, closingDate:date?.[1]||null, url }); seen.add(url);
  }); return jobs;
}

const tescoSearchUrl=(town,page)=>{ const u=new URL("/v2/job/search",TESCO_ORIGIN); u.searchParams.set("location",town); u.searchParams.set("location_country","1"); u.searchParams.set("location_range","10"); u.searchParams.set("page",String(page)); return u.href; };

async function getTescoTownJobs(town) {
  // Tesco's result order is unstable between requests, so wide multi-page searches skip and repeat jobs.
  // A 10-mile search per town keeps results to a page or two.
  const firstHtml=await fetchHtml(tescoSearchUrl(town,1));
  const $=cheerio.load(firstHtml);
  const pageNums=$('a[href*="/v2/job/search"]').map((_,a)=>Number(new URL($(a).attr("href"),TESCO_ORIGIN).searchParams.get("page"))||1).get();
  const lastPage=Math.min(20, Math.max(1, ...pageNums));
  const pages=await Promise.all(Array.from({length:lastPage-1},(_,i)=>fetchHtml(tescoSearchUrl(town,i+2))));
  return [firstHtml, ...pages].flatMap(parseTesco);
}

async function getTescoJobs() {
  const results=await Promise.allSettled(TOWNS.map(getTescoTownJobs));
  if(results.every(r=>r.status==="rejected")) throw results[0].reason;
  const all=results.flatMap(r=>r.status==="fulfilled"?r.value:[]);
  const jobs=[];
  for(const j of new Map(all.map(j=>[j.url,j])).values()){
    const town=TOWNS.find(t=>new RegExp(`\\b${t}\\b`,"i").test(`${j.location} ${j.title}`)); if(town) jobs.push({...j,town});
  }
  return jobs;
}

async function fetchScrewfixPage(page) {
  const u=new URL("/api/SFJobListingAPI",SCREWFIX_ORIGIN); u.searchParams.set("page",String(page));
  const r=await fetch(u,{ headers:{ "User-Agent":"Mozilla/5.0 (compatible; LocalJobsViewer/1.1; personal job search)", Accept:"application/json" }, signal:AbortSignal.timeout(15000) });
  if(!r.ok) throw new Error(`jobs.screwfix.com API returned HTTP ${r.status}`);
  return r.json();
}

async function getScrewfixJobs() {
  // The /job-search page is an empty shell populated by JS, so query the JSON API it uses directly.
  const first=await fetchScrewfixPage(1);
  const rest=await Promise.allSettled(Array.from({length:Math.max(0,(first.totalPages||1)-1)},(_,i)=>fetchScrewfixPage(i+2)));
  const all=[...first.jobDetails, ...rest.flatMap(p=>p.status==="fulfilled"?p.value.jobDetails:[])];
  const jobs=[];
  for(const j of all){
    const town=TOWNS.find(t=>new RegExp(`\\b${t}\\b`,"i").test(j.location||"")); if(!town) continue;
    jobs.push({company:"Screwfix",title:clean(j.jobTitle),location:clean(j.location),town,contract:j.contract?clean(j.contract):null,salary:j.salary||null,closingDate:null,url:absoluteUrl(j.url,SCREWFIX_ORIGIN)});
  }
  return [...new Map(jobs.map(j=>[j.url,j])).values()];
}

async function fetchLidlPage(page) {
  const u=new URL("/api/v1/search",LIDL_ORIGIN); u.searchParams.set("general",JSON.stringify({page,resultsPerPage:100,sortField:"",sortOrder:"asc"}));
  const r=await fetch(u,{ headers:{ "User-Agent":"Mozilla/5.0 (compatible; LocalJobsViewer/1.1; personal job search)", Accept:"application/json" }, signal:AbortSignal.timeout(15000) });
  if(!r.ok) throw new Error(`careers.lidl.co.uk API returned HTTP ${r.status}`);
  return r.json();
}

async function getLidlJobs() {
  // Like Screwfix, the Lidl search page is rendered by JS from a JSON API. Its location search needs
  // geocoded coordinates, so fetch the whole UK list (a few hundred jobs) and filter by town instead.
  const first=await fetchLidlPage(1);
  const lastPage=Math.min(20, Math.ceil((first.meta?.totalCount||0)/(first.meta?.resultsPerPage||100)));
  const rest=await Promise.all(Array.from({length:Math.max(0,lastPage-1)},(_,i)=>fetchLidlPage(i+2)));
  const jobs=[];
  for(const j of [first,...rest].flatMap(r=>r.jobs||[])){
    const loc=j.location||{}, place=`${loc.city||""} ${loc.name||""}`;
    const town=TOWNS.find(t=>new RegExp(`\\b${t}\\b`,"i").test(place)); if(!town) continue;
    const salary=(j.descResponsibilities||"").match(/£[\d.,]+(?:\s*-\s*£[\d.,]+)?\s*per (?:hour|annum|year)/i)?.[0]||null;
    const until=j.onlineUntil?new Date(j.onlineUntil):null;
    jobs.push({company:"Lidl",title:clean(j.title),location:clean([loc.address,loc.city,loc.zipCode].filter(Boolean).join(", "))||town,town,contract:[j.contractType,j.categories?.contract_duration?.value].filter(Boolean).join(" - ")||null,salary,closingDate:until?until.toLocaleDateString("en-GB",{day:"2-digit",month:"2-digit",year:"2-digit",timeZone:"Europe/London"}):null,url:j.jobDetailUrl||absoluteUrl(j.availableLanguages?.[0]?.href,LIDL_ORIGIN)});
  }
  return [...new Map(jobs.map(j=>[j.url,j])).values()];
}


const SOURCES={tesco:getTescoJobs,screwfix:getScrewfixJobs,lidl:getLidlJobs};

// Returns { status, body } so both the Azure Function and Express can send it as-is.
export async function getAllJobs() {
  const names=Object.keys(SOURCES), results=await Promise.allSettled(names.map(n=>SOURCES[n]()));
  const jobs=results.flatMap(r=>r.status==="fulfilled"?r.value:[]);
  if(results.every(r=>r.status==="rejected")) return {status:502,body:{error:"Could not retrieve job listings right now."}};
  return {status:200,body:{fetchedAt:new Date().toISOString(),count:jobs.length,jobs,errors:Object.fromEntries(names.map((n,i)=>[n,results[i].status==="rejected"?results[i].reason.message:null]))}};
}
