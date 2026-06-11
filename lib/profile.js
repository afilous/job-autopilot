/**
 * lib/profile.js — Candidate profile and shared answer helpers
 */

const PROFILE = {
  full_name: 'Aaron Filous',
  first_name: 'Aaron',
  last_name: 'Filous',
  email: 'filousaaron@gmail.com',
  phone: '6502913142',
  phone_formatted: '(650) 291-3142',
  linkedin: 'https://www.linkedin.com/in/aaron-filous/',
  location: 'San Mateo, CA',
  city: 'San Mateo',
  state: 'CA',
  zip: '94401',
  country: 'United States',
  website: 'https://frameandreel.com',
  heard_about: 'LinkedIn',
  authorized_to_work: 'Yes',
  requires_sponsorship: 'No',
  salary_expectation: '145000',
};

const ESSAY_ANSWERS = {
  proud: "I am most proud of building Promotable from scratch to $40k/month in revenue, selected as an education partner by 1871 Chicago's top tech incubator. I identified a gap in data skills training, built an automated omnichannel sales funnel, and converted a B2C audience to enterprise clients including McDonald's and City Colleges of Chicago.",
  why_company: "I am excited by the opportunity to apply my 10+ years of strategy and operations experience at a company building at the frontier. At Enova International I led a $200M portfolio consolidation and drove 200% increase in SDR productivity. I founded Promotable which grew to $40k/month revenue.",
  ambiguous: "At Enova I was handed a vague directive to wind down a $200M business unit with no playbook. I scoped the initiative, identified every cross-functional dependency across legal, compliance, product, finance and customer success, and drove it to completion on time.",
  beyond_title: "At App Academy I was hired as Business Operations Manager but ended up managing state regulatory relationships, running the financial audit conversion to GAAP, and building the CS team from scratch — none of which was in my job description.",
  program: "At Enova I led a cross-functional program to close a $200M loan portfolio end-to-end: scoping with the COO, coordinating across legal, compliance, finance, product, and customer success, managing weekly stakeholder reporting.",
  metrics: "I track leading indicators alongside outcomes — milestone completion, stakeholder alignment, risk items resolved per sprint. Post-completion I measure cost reduction vs target, compliance audit pass rate, and team retention through transition.",
  general: "My background spans 10+ years in strategy and operations. At Enova I led a $200M portfolio consolidation and built SDR operations from the ground up, driving cross-functional alignment across product, finance, and go-to-market teams.",
};

// Greenhouse dropdown answer mapping
function getDropdownAnswer(labelText) {
  const c = labelText.toLowerCase();
  if (c.includes('sponsor') || c.includes('visa') || c.includes('immigration') || c.includes('work permit') || c.includes('right to work support')) return 'No';
  if (c.includes('authorized') || c.includes('eligible to work') || c.includes('legally') || c.includes('right to work')) return 'Yes';
  if (c.includes('non-compete') || c.includes('non compete') || c.includes('non-solicit') || c.includes('former employer')) return 'No';
  if (c.includes('hybrid') || c.includes('in-office') || c.includes('in-person') || c.includes('relocat') || c.includes('willing to work') || c.includes('commit to being')) return 'Yes';
  if (c.includes('previously worked') || c.includes('worked for') || c.includes('formerly') || c.includes('ever worked') || c.includes('conflict of interest')) return 'No';
  if (c.includes('state of residence') || c.includes('current state') || c.includes('province')) return 'California';
  if (c.includes('metro') || c.includes('san francisco bay')) return 'San Francisco Bay';
  if (c.includes('veteran')) return 'I am not a protected veteran';
  if (c.includes('disability')) return 'No, I do not have a disability';
  if (c.includes('gender') || c.includes('race') || c.includes('ethnicity') || c.includes('ethnic') || c.includes('sexual orientation') || c.includes('lgbtq') || c.includes('transgender') || c.includes('pronoun')) return 'Decline';
  if (c.includes('school') || c.includes('university') || c.includes('college') || c.includes('institution')) return 'Georgetown University';
  if (c.includes('degree') || c.includes('level of education')) return "Master's";
  if (c.includes('discipline') || c.includes('field of study') || c.includes('major') || c.includes('area of study')) return 'European Studies';
  if (c.includes('graduation') || c.includes('grad year')) return '2015';
  if (c.includes('ai policy') || c.includes('use of ai') || c.includes('used ai')) return 'No';
  if (c.includes('m&a') || c.includes('merger') || c.includes('acquisition')) return 'No';
  if (c.includes('first-generation') || c.includes('first generation professional')) return 'Decline';
  if (c.includes('hear about') || c.includes('how did you') || c.includes('source') || c.includes('referred')) return 'LinkedIn';
  if (c.includes('sql') || c.includes('advanced knowledge')) return 'Yes';
  if (c.includes('do you') || c.includes('are you') || c.includes('can you') || c.includes('will you') || c.includes('have you')) return 'Yes';
  return null;
}

// Text answer mapping for open fields
function getTextAnswer(labelText) {
  const lt = labelText.toLowerCase();
  if (/linkedin/i.test(lt)) return PROFILE.linkedin;
  if (/website|portfolio/i.test(lt)) return PROFILE.website;
  if (/github/i.test(lt)) return 'https://github.com/afilous';
  if (/preferred.*name|first name/i.test(lt)) return PROFILE.first_name;
  if (/last name|surname/i.test(lt)) return PROFILE.last_name;
  if (/full.*name|legal.*name/i.test(lt)) return PROFILE.full_name;
  if (/pronouns/i.test(lt)) return 'He/Him';
  if (/city/i.test(lt)) return PROFILE.city;
  if (/zip|postal/i.test(lt)) return PROFILE.zip;
  if (/address/i.test(lt)) return 'San Mateo, CA 94401';
  if (/school|university|college/i.test(lt)) return 'Georgetown University';
  if (/degree|level of education/i.test(lt)) return "Master's";
  if (/discipline|field of study|major/i.test(lt)) return 'European Studies';
  if (/gpa/i.test(lt)) return '3.7';
  if (/graduation|grad.*year/i.test(lt)) return '2015';
  if (/company|employer/i.test(lt)) return 'Stealth Startup';
  if (/title|position/i.test(lt)) return 'Strategy & Operations Lead';
  if (/salary|compensation/i.test(lt)) return PROFILE.salary_expectation;
  if (/years.*experience/i.test(lt)) return '10';
  if (/start.*date|available/i.test(lt)) return 'Immediately';
  if (/why.*work|why.*join|what excites|what draws/i.test(lt)) return ESSAY_ANSWERS.why_company;
  if (/experience|background|describe/i.test(lt)) return ESSAY_ANSWERS.general;
  if (/sql/i.test(lt)) return 'Yes, I have advanced SQL skills including complex joins, window functions, and query optimization.';
  if (/cover.*letter|additional.*info|anything.*else/i.test(lt)) return 'Please see my attached resume for additional details.';
  if (/hear.*about|source|referred/i.test(lt)) return 'LinkedIn';
  return null;
}

module.exports = { PROFILE, ESSAY_ANSWERS, getDropdownAnswer, getTextAnswer };
