// Job fetching shared by the Azure Function (api/src/functions/jobs.js) and the local Express server (server.js).
import * as cheerio from "cheerio";

const TESCO_ORIGIN = "https://apply.tesco-careers.com";
const SCREWFIX_ORIGIN = "https://jobs.screwfix.com";
const LIDL_ORIGIN = "https://careers.lidl.co.uk";
const MCDONALDS_ORIGIN = "https://people.mcdonalds.co.uk";
const COOP_ORIGIN = "https://jobs.coop.co.uk";
const COSTA_ORIGIN = "https://costacareers.co.uk";
const TOOLSTATION_SEARCH = "https://www.toolstationjobs.com/find-your-job/vacancies/vacancy-search-results.aspx";
const TOWNS =["Horsham", "Crawley", "Billingshurst"];
// Postcode districts for each town, for sources that sometimes give only the county as the city.
const TOWN_POSTCODES={Horsham:/^RH1[23]\b/i,Crawley:/^RH1[01]\b/i,Billingshurst:/^RH14\b/i};

const clean = (v = "") => v.replace(/\s+/g, " ").trim();
// Normalises a source date to an ISO string, or null when missing or unparseable. Only some sources give a posted date.
function isoDate(v) { const d=v?new Date(v):null; return d&&!isNaN(d)?d.toISOString():null; }
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
    jobs.push({ company:"Tesco", title, location:location.replace(/\([^)]*\)/g,"").trim()||"Billingshurst", contract:contract?.[0]||null, salary:salary?.[0]||null, closingDate:date?.[1]||null, postedDate:null, url }); seen.add(url);
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
    jobs.push({company:"Screwfix",title:clean(j.jobTitle),location:clean(j.location),town,contract:j.contract?clean(j.contract):null,salary:j.salary||null,closingDate:null,postedDate:isoDate(j.updatedDate),url:absoluteUrl(j.url,SCREWFIX_ORIGIN)});
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
    jobs.push({company:"Lidl",title:clean(j.title),location:clean([loc.address,loc.city,loc.zipCode].filter(Boolean).join(", "))||town,town,contract:[j.contractType,j.categories?.contract_duration?.value].filter(Boolean).join(" - ")||null,salary,closingDate:until?until.toLocaleDateString("en-GB",{day:"2-digit",month:"2-digit",year:"2-digit",timeZone:"Europe/London"}):null,postedDate:isoDate(j.onlineFrom),url:j.jobDetailUrl||absoluteUrl(j.availableLanguages?.[0]?.href,LIDL_ORIGIN)});
  }
  return [...new Map(jobs.map(j=>[j.url,j])).values()];
}

function parseToolstation(html) {
  const $=cheerio.load(html), field=($j,id)=>clean($j.find(`[data-id="div_content_${id}"]`).text())||null;
  return $(".vsr-job").map((_,el)=>{
    const $j=$(el), $a=$j.find(".vsr-job__title a").first(), end=field($j,"VacV_AdvertisingEndDate"), endDate=end?new Date(`${end} 12:00 UTC`):null;
    return {company:"Toolstation",title:clean($a.text()),location:field($j,"VacV_LocationID")||"",contract:field($j,"Question_1_262"),salary:field($j,"VacV_DisplaySalary"),closingDate:endDate&&!isNaN(endDate)?endDate.toLocaleDateString("en-GB",{day:"2-digit",month:"2-digit",year:"2-digit",timeZone:"Europe/London"}):end,postedDate:null,url:absoluteUrl($a.attr("href"),TOOLSTATION_SEARCH)};
  }).get();
}

async function getToolstationJobs() {
  // An ASP.NET WebForms site: the search filters and pager only work via postbacks, so page through the
  // full UK list (under 100 jobs) by replaying the form with the pager's __EVENTTARGET, and filter by town.
  const headers={"User-Agent":"Mozilla/5.0 (compatible; LocalJobsViewer/1.1; personal job search)",Accept:"text/html,application/xhtml+xml"};
  let r=await fetch(TOOLSTATION_SEARCH,{headers,signal:AbortSignal.timeout(15000)});
  if(!r.ok) throw new Error(`toolstationjobs.com returned HTTP ${r.status}`);
  const cookie=r.headers.getSetCookie().map(c=>c.split(";")[0]).join("; ");
  let html=await r.text(); const all=[];
  for(let page=1;page<=20;page++){
    all.push(...parseToolstation(html));
    const $=cheerio.load(html), pager=$('a[href*="VacancyPager"]').filter((_,a)=>$(a).attr("href").includes(`'${page+1}'`)).first().attr("href")?.match(/__doPostBack\('([^']+)'/)?.[1];
    if(!pager) break;
    const form=new URLSearchParams();
    $("#aspnetForm").find("input[name], select[name]").each((_,e)=>{
      const $e=$(e), type=($e.attr("type")||"").toLowerCase();
      if(/submit|button|image|checkbox|radio/.test(type)&&$e.attr("checked")===undefined) return;
      form.append($e.attr("name"), e.tagName==="select"?($e.find("option[selected]").attr("value")??$e.find("option").first().attr("value")??""):($e.attr("value")??""));
    });
    form.set("__EVENTTARGET",pager); form.set("__EVENTARGUMENT",String(page+1));
    r=await fetch(TOOLSTATION_SEARCH,{method:"POST",headers:{...headers,"Content-Type":"application/x-www-form-urlencoded",Cookie:cookie},body:form,signal:AbortSignal.timeout(15000)});
    if(!r.ok) throw new Error(`toolstationjobs.com returned HTTP ${r.status}`);
    html=await r.text();
  }
  const jobs=[];
  for(const j of all){ const town=TOWNS.find(t=>new RegExp(`\\b${t}\\b`,"i").test(`${j.location} ${j.title}`)); if(town&&j.url) jobs.push({...j,location:j.location||town,town}); }
  return [...new Map(jobs.map(j=>[j.url,j])).values()];
}

async function getMcDonaldsJobs() {
  // The job search page is an Algolia InstantSearch app; query its index directly with the public search-only
  // key from the page (it is restricted to the site's referer). A 30km radius around Horsham covers all three towns.
  const r=await fetch("https://RVMOB42DFH-dsn.algolia.net/1/indexes/production__mcdscare2501__sort-rank/query",{method:"POST",headers:{"X-Algolia-Application-Id":"RVMOB42DFH","X-Algolia-API-Key":"0a69e536b78a0eb7abf95cf3331caf64",Referer:`${MCDONALDS_ORIGIN}/job-search`,"Content-Type":"application/json"},body:JSON.stringify({params:new URLSearchParams({query:"",aroundLatLng:"51.0629,-0.3259",aroundRadius:"30000",hitsPerPage:"1000",attributesToHighlight:"",attributesToSnippet:"",attributesToRetrieve:"title,display_address,display_salary,contract_type,jd_url"}).toString()}),signal:AbortSignal.timeout(15000)});
  if(!r.ok) throw new Error(`McDonald's job search returned HTTP ${r.status}`);
  const jobs=[];
  for(const j of (await r.json()).hits||[]){
    const town=TOWNS.find(t=>new RegExp(`\\b${t}\\b`,"i").test(j.display_address||"")); if(!town) continue;
    const salary=j.display_salary?clean(j.display_salary).replace(/^(?=\d)/,"£"):null;
    jobs.push({company:"McDonald's",title:clean(j.title),location:clean(j.display_address),town,contract:j.contract_type?clean(j.contract_type):null,salary,closingDate:null,postedDate:null,url:absoluteUrl(j.jd_url,MCDONALDS_ORIGIN)});
  }
  return [...new Map(jobs.map(j=>[j.url,j])).values()];
}

async function fetchCoopPage(page) {
  const u=new URL("/search-jobs/results",COOP_ORIGIN);
  for(const [k,v] of Object.entries({ActiveFacetID:"0",CurrentPage:String(page),RecordsPerPage:"100",Keywords:"",Location:"",SearchResultsModuleName:"Search Results",SearchFiltersModuleName:"Search Filters",SortCriteria:"0",SortDirection:"0",SearchType:"1",OrganizationIds:"22964",ResultsType:"0"})) u.searchParams.set(k,v);
  const r=await fetch(u,{ headers:{ "User-Agent":"Mozilla/5.0 (compatible; LocalJobsViewer/1.1; personal job search)", Accept:"application/json", "X-Requested-With":"XMLHttpRequest" }, signal:AbortSignal.timeout(15000) });
  if(!r.ok) throw new Error(`jobs.coop.co.uk returned HTTP ${r.status}`);
  return cheerio.load((await r.json()).results||"");
}

async function getCoopJobs() {
  // A TalentBrew site whose search page loads results from a JSON endpoint wrapping an HTML fragment. Its location
  // search needs geocoded place IDs, so like Lidl fetch the whole UK list (a few hundred jobs) and filter by town.
  const first=await fetchCoopPage(1);
  const lastPage=Math.min(20, Number(first("#search-results").attr("data-total-pages"))||1);
  const rest=await Promise.all(Array.from({length:Math.max(0,lastPage-1)},(_,i)=>fetchCoopPage(i+2)));
  const jobs=[];
  for(const $ of [first,...rest]) $("#search-results-jobs li a[href]").each((_,el)=>{
    const $a=$(el), title=clean($a.find(".global-job-list__job-title").text()), location=clean($a.find(".job-location").text());
    const town=TOWNS.find(t=>new RegExp(`\\b${t}\\b`,"i").test(`${location} ${title}`)); if(!town||!title) return;
    jobs.push({company:"Co-op",title,location,town,contract:clean($a.find(".job-contract").text())||null,salary:clean($a.find(".job-level").text())||null,closingDate:null,postedDate:null,url:absoluteUrl($a.attr("href"),COOP_ORIGIN)});
  });
  return [...new Map(jobs.map(j=>[j.url,j])).values()];
}

async function fetchCostaPage(page) {
  // Pages are numbered from 0. The endpoint ignores the location filter unless the body is form-encoded.
  const body=new URLSearchParams({"paginate[page]":String(page),"paginate[per_page]":"100","location[range]":"10","location[address]":"Horsham","status[]":"publish"});
  const r=await fetch(`${COSTA_ORIGIN}/wp-json/posts/search`,{method:"POST",headers:{"User-Agent":"Mozilla/5.0 (compatible; LocalJobsViewer/1.1; personal job search)",Accept:"application/json","Content-Type":"application/x-www-form-urlencoded; charset=UTF-8","X-Requested-With":"XMLHttpRequest"},body,signal:AbortSignal.timeout(15000)});
  if(!r.ok) throw new Error(`costacareers.co.uk returned HTTP ${r.status}`);
  return r.json();
}

async function getCostaJobs() {
  // The WordPress job search page is filled by JS from a JSON endpoint; a 10-mile search around Horsham covers all three towns.
  const first=await fetchCostaPage(0);
  const rest=await Promise.all(Array.from({length:Math.max(0,Math.min(20,first.total_pages||1)-1)},(_,i)=>fetchCostaPage(i+1)));
  const jobs=[];
  for(const j of [first,...rest].flatMap(d=>d.results||[])){
    const title=clean(j.post_title), location=clean(j.full_location);
    const town=TOWNS.find(t=>new RegExp(`\\b${t}\\b`,"i").test(`${location} ${title}`)); if(!town||!j.permalink) continue;
    jobs.push({company:"Costa",title,location,town,contract:j.employment_indicator?clean(j.employment_indicator):null,salary:null,closingDate:null,postedDate:j.posted_at?isoDate(`${j.posted_at.replace(" ","T")}Z`):null,url:j.permalink});
  }
  return [...new Map(jobs.map(j=>[j.url,j])).values()];
}

async function getStarbucksJobs() {
  // The Angular search page loads from this JSON API. It returns at most 100 UK vacancies, sorted by distance
  // when given coordinates, so search around Horsham and filter by town name or postcode.
  const u=new URL("https://starbuckscareersapi.ats.careers/api/vacancies"); u.searchParams.set("Latitude","51.0629"); u.searchParams.set("Longitude","-0.3259");
  const r=await fetch(u,{headers:{"User-Agent":"Mozilla/5.0 (compatible; LocalJobsViewer/1.1; personal job search)",Accept:"application/json",Origin:"https://www.starbucksemeacareers.com"},signal:AbortSignal.timeout(15000)});
  if(!r.ok) throw new Error(`Starbucks careers API returned HTTP ${r.status}`);
  const jobs=[];
  for(const j of await r.json()){
    const [title,store]=clean(j.jobTitle).split(/\s+-\s+Store#\s*/i), postcode=clean(j.postalCode);
    const town=TOWNS.find(t=>new RegExp(`\\b${t}\\b`,"i").test(`${j.city} ${store||""}`))||TOWNS.find(t=>TOWN_POSTCODES[t].test(postcode)); if(!town||!j.externalURLRet) continue;
    jobs.push({company:"Starbucks",title,location:[store?.replace(/^\d+,\s*/,""),j.city,postcode].filter(Boolean).map(clean).join(", ")||town,town,contract:null,salary:null,closingDate:null,postedDate:null,url:j.externalURLRet});
  }
  return [...new Map(jobs.map(j=>[j.url,j])).values()];
}

async function fetchMorrisonsPage(offset) {
  const u=new URL("https://www.morrisons.jobs/api/jobs"); u.searchParams.set("limit","1000"); u.searchParams.set("offset",String(offset)); u.searchParams.set("source","advSearch");
  const r=await fetch(u,{headers:{"User-Agent":"Mozilla/5.0 (compatible; LocalJobsViewer/1.1; personal job search)",Accept:"application/json","X-Requested-With":"XMLHttpRequest"},signal:AbortSignal.timeout(15000)});
  if(!r.ok) throw new Error(`morrisons.jobs API returned HTTP ${r.status}`);
  return r.json();
}

async function getMorrisonsJobs() {
  // The job search page is filled by JS from a JSON feed. Its postcode search returns nothing without geocoding,
  // so like Lidl fetch the whole UK list (under 1,000 jobs, one request) and filter by town name or postcode.
  const first=await fetchMorrisonsPage(0);
  const rest=await Promise.all(Array.from({length:Math.max(0,Math.min(20,first.results_pages||1)-1)},(_,i)=>fetchMorrisonsPage((i+1)*1000)));
  const jobs=[];
  for(const j of [first,...rest].flatMap(d=>d.jobs||[])){
    const location=clean(j.formatted_address).replace(/,\s*United Kingdom\b/i,""), postcode=clean(j.location_postcode);
    const town=TOWNS.find(t=>new RegExp(`\\b${t}\\b`,"i").test(location))||TOWNS.find(t=>TOWN_POSTCODES[t].test(postcode)); if(!town||!j.job_url) continue;
    const closing=j.closing_date?new Date(`${j.closing_date.replace(" ","T")}Z`):null;
    // salary_display is the same "Competitive salary" boilerplate on every job, so leave it out.
    jobs.push({company:"Morrisons",title:clean(j.job_title),location:location||town,town,contract:[j.contract_type,j.hours_per_week&&`${j.hours_per_week} hrs/week`].filter(Boolean).join(" - ")||null,salary:null,closingDate:closing&&!isNaN(closing)?closing.toLocaleDateString("en-GB",{day:"2-digit",month:"2-digit",year:"2-digit",timeZone:"Europe/London"}):null,postedDate:j.ats_created_timestamp_utc?isoDate(`${j.ats_created_timestamp_utc.replace(" ","T")}Z`):null,url:j.job_url});
  }
  return [...new Map(jobs.map(j=>[j.url,j])).values()];
}

function parseSainsburys(html) {
  const $=cheerio.load(html);
  const jobs=$(".jobs-card").map((_,el)=>{
    // The subheading is "Store <br> Postcode <br> Salary <br> Contract", with salary or contract sometimes missing.
    const $c=$(el), parts=($c.find("h4 span").html()||"").split(/<br\s*\/?>/i).map(s=>clean(cheerio.load(s).text())).filter(Boolean);
    const postcode=parts.find(p=>/^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(p))||"", salary=parts.find(p=>/£|competitive|per hour|per annum|salary/i.test(p))||null, contract=parts.find(p=>/permanent|temporary|fixed|seasonal|part[- ]?time|full[- ]?time/i.test(p))||null;
    return {company:"Sainsbury's",title:clean($c.find("h3").text()),location:parts.filter(p=>p!==salary&&p!==contract).join(", "),postcode,contract,salary,closingDate:null,postedDate:null,url:absoluteUrl($c.find("a[href]").last().attr("href"),"https://www.sainsburys.jobs")};
  }).get();
  const range=clean($(".pagination-div span").first().text()).match(/(\d+)\s*of\s*(\d+)/);
  return {jobs,more:!!range&&Number(range[1])<Number(range[2])};
}

async function getSainsburysTownJobs(town) {
  // The page server-renders the first 9 results from ?location=, but ?page= redirects back to page 1, so later
  // pages come from the WordPress AJAX endpoint the pager uses, with the nonce embedded in the first page.
  const u=new URL("https://www.sainsburys.jobs/jobs/"); u.searchParams.set("location",town);
  const html=await fetchHtml(u.href), nonce=html.match(/"nonce":"([^"]+)"/)?.[1];
  let {jobs:all,more}=parseSainsburys(html);
  for(let page=2;more&&nonce&&page<=20;page++){
    const body=new FormData(); for(const [k,v] of Object.entries({action:"sbjobs_search",nonce,location:town,page:String(page)})) body.append(k,v);
    const r=await fetch("https://www.sainsburys.jobs/wp-admin/admin-ajax.php",{method:"POST",headers:{"User-Agent":"Mozilla/5.0 (compatible; LocalJobsViewer/1.1; personal job search)",Accept:"application/json"},body,signal:AbortSignal.timeout(15000)});
    if(!r.ok) throw new Error(`sainsburys.jobs returned HTTP ${r.status}`);
    const d=await r.json(); if(!d.success) break;
    const res=parseSainsburys(d.data?.html||""); all.push(...res.jobs); more=res.more&&res.jobs.length>0;
  }
  return all;
}

async function getSainsburysJobs() {
  // A WordPress site whose job search takes a free-text location, so search per town. Store names don't always
  // include the town (Crawley's is "West Green Store"), so also match by postcode.
  const results=await Promise.allSettled(TOWNS.map(getSainsburysTownJobs));
  if(results.every(r=>r.status==="rejected")) throw results[0].reason;
  const jobs=[];
  for(const {postcode,...j} of results.flatMap(r=>r.status==="fulfilled"?r.value:[])){
    const town=TOWNS.find(t=>new RegExp(`\\b${t}\\b`,"i").test(j.location))||TOWNS.find(t=>TOWN_POSTCODES[t].test(postcode)); if(town&&j.url&&j.title) jobs.push({...j,town});
  }
  return [...new Map(jobs.map(j=>[j.url,j])).values()];
}

const SOURCES={tesco:getTescoJobs,screwfix:getScrewfixJobs,lidl:getLidlJobs,toolstation:getToolstationJobs,mcdonalds:getMcDonaldsJobs,coop:getCoopJobs,costa:getCostaJobs,starbucks:getStarbucksJobs,morrisons:getMorrisonsJobs,sainsburys:getSainsburysJobs};

// Returns { status, body } so both the Azure Function and Express can send it as-is.
export async function getAllJobs() {
  const names=Object.keys(SOURCES), results=await Promise.allSettled(names.map(n=>SOURCES[n]()));
  const jobs=results.flatMap(r=>r.status==="fulfilled"?r.value:[]);
  if(results.every(r=>r.status==="rejected")) return {status:502,body:{error:"Could not retrieve job listings right now."}};
  return {status:200,body:{fetchedAt:new Date().toISOString(),count:jobs.length,jobs,errors:Object.fromEntries(names.map((n,i)=>[n,results[i].status==="rejected"?results[i].reason.message:null]))}};
}
