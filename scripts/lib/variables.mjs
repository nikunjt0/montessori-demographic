// ACS / Decennial variables pulled per block group, with friendly names.

/** ACS 2024 5-year detailed tables. */
export const ACS_VARS = {
  // --- Population and age (B01001 Sex by Age, B01003 Total) -----------------
  pop: "B01003_001E",
  maleUnder5: "B01001_003E",
  male5to9: "B01001_004E",
  femaleUnder5: "B01001_027E",
  female5to9: "B01001_028E",

  // --- Income and wealth ---------------------------------------------------
  medianHhIncome: "B19013_001E",
  medianFamilyIncome: "B19113_001E",
  medianHomeValue: "B25077_001E",

  // --- Housing age: the new-subdivision signal (B25034 Year Built) ---------
  housingUnits: "B25034_001E",
  built2020plus: "B25034_002E",
  built2010to2019: "B25034_003E",
  built2000to2009: "B25034_004E",

  // --- Tenure --------------------------------------------------------------
  tenureTotal: "B25003_001E",
  ownerOccupied: "B25003_002E",

  // --- Households and families ---------------------------------------------
  households: "B11001_001E",
  familyHouseholds: "B11001_002E",
  hhWithKidsUnder18: "B11005_002E",

  // --- Working-parent demand (B23008) --------------------------------------
  // The core daycare-need signal: children under 6 whose available parents
  // are ALL in the labor force, i.e. children who structurally need care.
  kidsUnder6InFamilies: "B23008_002E",
  kidsUnder6TwoParents: "B23008_003E",
  kidsUnder6BothParentsLF: "B23008_004E",
  kidsUnder6OneParent: "B23008_008E",
  kidsUnder6DadOnlyLF: "B23008_010E",
  kidsUnder6MomOnlyLF: "B23008_013E",

  // --- Education (proxies willingness to pay for Montessori specifically) ---
  eduTotal: "B15003_001E",
  eduBachelors: "B15003_022E",
  eduMasters: "B15003_023E",
  eduProfessional: "B15003_024E",
  eduDoctorate: "B15003_025E",

  // --- Poverty (affordability floor / CCAP subsidy relevance) --------------
  povertyUniverse: "B17001_001E",
  povertyBelow: "B17001_002E",
};

/**
 * 2020 Decennial DHC. Uses the SAME 2020 block-group boundaries as ACS 2024,
 * so it is a valid growth baseline. (The 2019 ACS is NOT — block groups were
 * redrawn for the 2020 census, so a 2019-vs-2024 delta would compare
 * different shapes.)
 */
export const DEC_VARS = {
  pop2020: "P1_001N",
  housingUnits2020: "H1_001N",
};
