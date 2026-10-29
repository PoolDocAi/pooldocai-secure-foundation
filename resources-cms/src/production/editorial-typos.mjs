// High-confidence, locally auditable spelling suggestions only. Never silently fix
// trademark/model names, chemical values, URLs, markup, or unfamiliar words.
const MISSPELLINGS = Object.freeze({
  "accomodate": "accommodate",
  "acheive": "achieve",
  "adress": "address",
  "aggregrate": "aggregate",
  "algie": "algae",
  "algea": "algae",
  "alge": "algae",
  "algeacide": "algaecide",
  "algacide": "algaecide",
  "algaecidees": "algaecides",
  "alkalinty": "alkalinity",
  "alkalnity": "alkalinity",
  "alkalinitiy": "alkalinity",
  "alkalniity": "alkalinity",
  "alot": "a lot",
  "apropriate": "appropriate",
  "attatched": "attached",
  "availble": "available",
  "becuase": "because",
  "buisness": "business",
  "calcuim": "calcium",
  "calicum": "calcium",
  "calibraiton": "calibration",
  "calibation": "calibration",
  "chemcial": "chemical",
  "chemcials": "chemicals",
  "chck": "check",
  "chlorene": "chlorine",
  "chlorne": "chlorine",
  "chlroine": "chlorine",
  "cholrine": "chlorine",
  "chloirne": "chlorine",
  "clorine": "chlorine",
  "clorhine": "chlorine",
  "circluation": "circulation",
  "ciruclation": "circulation",
  "circualtion": "circulation",
  "circulaton": "circulation",
  "circultion": "circulation",
  "commerical": "commercial",
  "concetration": "concentration",
  "concentraiton": "concentration",
  "conenction": "connection",
  "consistant": "consistent",
  "contanimated": "contaminated",
  "contimnation": "contamination",
  "corrossion": "corrosion",
  "corosion": "corrosion",
  "decrese": "decrease",
  "descripton": "description",
  "diffrent": "different",
  "dissolvedd": "dissolved",
  "dissovled": "dissolved",
  "equiipment": "equipment",
  "equipement": "equipment",
  "equipmet": "equipment",
  "equipmnt": "equipment",
  "evapration": "evaporation",
  "excesss": "excess",
  "expereince": "experience",
  "filteer": "filter",
  "fiter": "filter",
  "fliter": "filter",
  "filtter": "filter",
  "filtre": "filter",
  "filtation": "filtration",
  "filration": "filtration",
  "filteration": "filtration",
  "filtraiton": "filtration",
  "filtratoin": "filtration",
  "frequenty": "frequently",
  "guage": "gauge",
  "guages": "gauges",
  "heigth": "height",
  "hieght": "height",
  "immediatly": "immediately",
  "inletss": "inlets",
  "inspeciton": "inspection",
  "instalation": "installation",
  "instal": "install",
  "maintainance": "maintenance",
  "maintenace": "maintenance",
  "maintanence": "maintenance",
  "maintence": "maintenance",
  "manfacturer": "manufacturer",
  "manufacter": "manufacturer",
  "manufactuer": "manufacturer",
  "mesurement": "measurement",
  "measurment": "measurement",
  "measurments": "measurements",
  "necesssary": "necessary",
  "occured": "occurred",
  "occuring": "occurring",
  "perfrom": "perform",
  "presure": "pressure",
  "presssure": "pressure",
  "pressue": "pressure",
  "probelm": "problem",
  "recomend": "recommend",
  "recomended": "recommended",
  "requirment": "requirement",
  "requred": "required",
  "resistence": "resistance",
  "responce": "response",
  "recieve": "receive",
  "recieved": "received",
  "saftey": "safety",
  "sanitizerz": "sanitizers",
  "sanitizeres": "sanitizers",
  "sanitizor": "sanitizer",
  "santicizer": "sanitizer",
  "seperately": "separately",
  "seperate": "separate",
  "seperation": "separation",
  "simmilar": "similar",
  "simmple": "simple",
  "stablizer": "stabilizer",
  "stablizers": "stabilizers",
  "stabilzer": "stabilizer",
  "stabilizor": "stabilizer",
  "suctionn": "suction",
  "swiming": "swimming",
  "swimingpool": "swimming pool",
  "technican": "technician",
  "teh": "the",
  "tempereture": "temperature",
  "temperture": "temperature",
  "temperatue": "temperature",
  "thermostattt": "thermostat",
  "troubleshoting": "troubleshooting",
  "trubleshooting": "troubleshooting",
  "understad": "understand",
  "unusal": "unusual",
  "vaccum": "vacuum",
  "vaccuum": "vacuum",
  "vaccuuming": "vacuuming",
  "valave": "valve",
  "vavle": "valve",
  "vavles": "valves",
  "waterr": "water",
  "wat": "what",
  "poo": "pool",
  "watre": "water",
  "wateer": "water",
  "wier": "weir",
  "yeild": "yield"
});
const FIELD_ORDER = ['title','summary','body','seo.title','seo.description'];
const textTokens = /\b[A-Za-z][A-Za-z]{2,}\b/g;
// A small conservative glossary supplements exact known misspellings for
// one-edit near matches. This is not an exhaustive language dictionary.
const GLOSSARY = new Set((
  'above across active add added adding adjust adjusted adjustment after again against algae algaecide alkalinity amount analysis area around ask automation available backwash backwashing bacteria balance balanced baseline before below best between body booster both bromine buildup calcium calibrate calibration cartridge cartridges chemical chemicals check checked checking chlorine chlorinator chlorinators circulation circulate circulating clear cleaner cleaners cleaning cloudy cold color combined commercial common compare condition connection contamination control controller correct corrosion cover covers daily damage debris decrease design detail device diagnosis diagnostic difference direction dirty disinfection dissolved dosage dose drain drainage electrical elements energy enough ensure equal equipment estimate evaporation every examine expected explain fail failure faulty feature filter filtered filtering filtration filters fittings flow flowing frequently full function gas gasket gauges gauge general green guide guidelines hardness hazardous heater heated heating help high homeowner homeowners hose hoses hours hydraulic identify identify image important improve increase inlet inlets initial inspect inspection install installation installed instructions issue issues keep knowledge learn learning leak leaking level levels light limit limited location low maintenance manual manuals manufacturer manufacturers material measure measured measurement measures method mixing model models monitor monitoring motor motors necessary normal notice observation observations operating operator output over overflow owner owners parts passes perform performance periodic plumbing pool pools position possible power pressure pressures prevent procedure process production pump pumps qualified quality quick reading readings ready recommend recommended record recorded recording recovery reference references regulator regulate replace replacement request require required requirements resource resources result results retain return review reviewer revision revisions rinse rinsing routine run running safety salt sanitize sanitizer sanitizers sanitizing scale schedule screening search season seasonal separate service servicing setting settings show signal size skim skimmer skimmers slow solution source sources specific speed speeds spring stabilize stabilizer stabilizers stages start starting stop stopped storage suction summary support surface system systems tank tanks temperature temperatures test tested testing tests technician technicians technical time total treatment trouble troubleshooting trouble value values valve valves verify verified version voltage volume wash waste water watery weekly winter winterizing wiring working works write writing'
).split(/\s+/));

function oneEditAway(a,b) {
  if(a===b || Math.abs(a.length-b.length)>1)return false;
  if(a.length===b.length){
    const at=[];
    for(let i=0;i<a.length;i++)if(a[i]!==b[i])at.push(i);
    return at.length===1||(at.length===2&&at[1]===at[0]+1&&a[at[0]]===b[at[1]]&&a[at[1]]===b[at[0]]);
  }
  const shorter=a.length<b.length?a:b,longer=a.length<b.length?b:a;
  let i=0,j=0,diffs=0;
  while(i<shorter.length&&j<longer.length) {
    if(shorter[i]===longer[j]){i++;j++;}
    else{j++;if(++diffs>1)return false;}
  }
  return true;
}
function nearMiss(word) {
  if(word.length<6||word.length>18||GLOSSARY.has(word))return null;
  let candidate=null;
  for(const term of GLOSSARY) {
    if(term[0]!==word[0]||Math.abs(term.length-word.length)>1)continue;
    if(!oneEditAway(word,term))continue;
    if(candidate)return null; // Ambiguous suggestions require manual review.
    candidate=term;
  }
  // Ordinary plurals and third-person verbs are not misspellings of their
  // singular/base forms. Avoid noisy false positives such as "checks".
  if(candidate && word.endsWith('s') && word.slice(0,-1)===candidate)return null;
  return candidate;
}


function caseLike(original, replacement) {
  if (original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase()) return replacement[0].toUpperCase()+replacement.slice(1);
  return replacement;
}

function parts(article, field) {
  if (field === 'body') {
    const html=String(article.body||'');
    return [...html.matchAll(/>([^<]*)</g)].map(m=>({value:m[1], start:m.index+1}));
  }
  const raw=field.startsWith('seo.')?article.seo?.[field.slice(4)]:article[field];
  return [{value:String(raw||''),start:0}];
}

export function spellingSuggestions(article, limit=30) {
  const proposals=[];
  for (const field of FIELD_ORDER) {
    for (const segment of parts(article,field)) {
      for (const match of segment.value.matchAll(textTokens)) {
        const before=match[0];
        const exact=MISSPELLINGS[before.toLowerCase()];
        const correction=exact || (before===before.toLowerCase()?nearMiss(before):null);
        if (!correction) continue;
        const after=caseLike(before,correction),start=segment.start+match.index;
        proposals.push({
          id:'spelling-'+field.replace('.','-')+'-'+start,
          kind:'spelling',field,start,before,after,
          context:segment.value.slice(Math.max(0,match.index-60),Math.min(segment.value.length,match.index+before.length+70)),
          why:before.toLowerCase()==='poo'
            ? 'Possible missing final "l": "poo" may have been intended as "pool". However, "poo" can correctly refer to feces in contamination guidance. Check this highlighted sentence and approve only if "pool" is intended.'
            : exact
              ? 'Possible spelling mistake: "'+before+'" is commonly written "'+after+'". Confirm it fits the sentence.'
              : 'This word looks one typing error away from "'+after+'", but may be intentional. Check the exact passage before approving.',
          requiresSourceCheck:false
        });
        if(proposals.length>=limit)return proposals;
      }
    }
  }
  return proposals;
}

// The server checks the exact position and old text before applying each
// approved edit; unselected tokens and all other fields remain unchanged.
export function applySpellingEdits(article, approved) {
  const changed=structuredClone(article);
  for (const field of FIELD_ORDER) {
    const edits=approved.filter(p=>p.field===field).sort((a,b)=>b.start-a.start);
    if(!edits.length)continue;
    let value=String(field.startsWith('seo.')?changed.seo?.[field.slice(4)]||'':changed[field]||'');
    for(let i=1;i<edits.length;i++){
      const higher=edits[i-1],lower=edits[i];
      if(lower.start+lower.before.length>higher.start)
        throw Object.assign(new Error('Approved corrections overlap. Approve only one and screen again.'),{status:409});
    }
    for(const edit of edits) {
      if(value.slice(edit.start,edit.start+edit.before.length)!==edit.before)
        throw Object.assign(new Error('The highlighted spelling changed; screen the current revision again'),{status:409});
      value=value.slice(0,edit.start)+edit.after+value.slice(edit.start+edit.before.length);
    }
    if(field.startsWith('seo.'))changed.seo={...(changed.seo||{}),[field.slice(4)]:value};
    else changed[field]=value;
  }
  return changed;
}
