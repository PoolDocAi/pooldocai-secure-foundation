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
  "watre": "water",
  "wateer": "water",
  "wier": "weir",
  "yeild": "yield"
});
const FIELD_ORDER = ['title','summary','body','seo.title','seo.description'];
const textTokens = /\b[A-Za-z][A-Za-z]{2,}\b/g;

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
        const correction=MISSPELLINGS[before.toLowerCase()];
        if (!correction) continue;
        const after=caseLike(before,correction),start=segment.start+match.index;
        proposals.push({
          id:'spelling-'+field.replace('.','-')+'-'+start,
          kind:'spelling',field,start,before,after,
          context:segment.value.slice(Math.max(0,match.index-60),Math.min(segment.value.length,match.index+before.length+70)),
          why:'Possible spelling mistake: "'+before+'" is commonly written "'+after+'". Review the wording and approve only if it fits this sentence.',
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
