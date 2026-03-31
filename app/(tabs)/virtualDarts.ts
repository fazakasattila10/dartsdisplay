export type VirtualLegPlan = {
  darts: number[];
  turns: number[];
  startScores: number[];
  avgPerDart: number;
};

const LEFT_NEIGHBORS = [20, 15, 17, 18, 12, 13, 19, 16, 14, 6, 8, 9, 4, 11, 10, 7, 2, 1, 3, 5];
const RIGHT_NEIGHBORS = [18, 17, 19, 13, 20, 10, 16, 11, 12, 15, 14, 5, 6, 9, 2, 8, 3, 4, 7, 1];

export const NON_THROWABLE = new Set([163, 166, 169, 172, 173, 175, 176, 178, 179, 181]);
export const NON_2_DART = new Set([99, 102, 103, 105, 106, 108, 109, 111]);
export const NON_3_DART = new Set([159, 162, 163, 165, 166, 168, 169, 171]);

export const LEVEL_CONFIGS: Record<number, [number, number, number, number, number, number, number]> = {
  1: [0.35, 0.1, 0.25, 0.28, 0.29, 5.0, 10.0],
  2: [0.4, 0.13, 0.28, 0.25, 0.25, 8.5, 13.0],
  3: [0.45, 0.14, 0.3, 0.23, 0.22, 11.0, 15.0],
  4: [0.62, 0.19, 0.37, 0.2, 0.2, 13.0, 18.0],
  5: [0.65, 0.22, 0.39, 0.18, 0.17, 15.0, 20.0],
  6: [0.7, 0.26, 0.4, 0.17, 0.13, 17.0, 22.0],
  7: [0.75, 0.285, 0.43, 0.15, 0.11, 19.0, 24.0],
  8: [0.8, 0.33, 0.48, 0.15, 0.07, 21.0, 26.0],
  9: [0.85, 0.39, 0.55, 0.12, 0.05, 23.0, 28.0],
  10: [0.9, 0.5, 0.7, 0.09, 0.03, 25.0, 30.0],
  11: [0.9, 0.57, 0.8, 0.05, 0.02, 28.0, 34.0],
  12: [0.97, 0.7, 0.8, 0.03, 0.02, 31.0, 42.0],
};

const CHECKOUT_3_DART: Record<number, string> = {
  99: 'T19', 100: 'T20', 101: 'T17', 102: 'T20', 103: 'T19', 104: 'T20', 105: 'T20', 106: 'T20',
  107: 'T19', 108: 'T19', 109: 'T20', 110: 'T20', 111: 'T20', 112: 'T20', 113: 'T20', 114: 'T20',
  115: 'T19', 116: 'T20', 117: 'T20', 118: 'T20', 119: 'T19', 120: 'T20', 121: 'T20', 122: 'T18',
  123: 'T20', 124: 'T20', 125: 'T20', 126: 'T19', 127: 'T20', 128: 'T20', 129: 'T19', 130: 'T20',
  131: 'T20', 132: 'T20', 133: 'T20', 134: 'T20', 135: 'T20', 136: 'T20', 137: 'T20', 138: 'T20',
  139: 'T20', 140: 'T20', 141: 'T20', 142: 'T20', 143: 'T20', 144: 'T20', 145: 'T20', 146: 'T20',
  147: 'T20', 148: 'T20', 149: 'T20', 150: 'T20', 151: 'T20', 152: 'T20', 153: 'T20', 154: 'T20',
  155: 'T20', 156: 'T20', 157: 'T19', 158: 'T20', 159: 'T19', 160: 'T20', 161: 'T20', 162: 'T20',
  163: 'T20', 164: 'T19', 165: 'T20', 166: 'T20', 167: 'T20', 168: 'T20', 169: 'T20', 170: 'T20',
};

const CHECKOUT_2_DART: Record<number, string> = {
  3:'1',5:'1',7:'3',9:'1',11:'3',13:'5',15:'7',17:'1',19:'3',21:'5',23:'7',25:'9',27:'11',29:'13',31:'15',
  33:'1',35:'3',37:'5',39:'7',41:'9',42:'10',43:'11',44:'12',45:'13',46:'14',47:'15',48:'16',49:'17',50:'18',
  51:'19',52:'20',53:'13',54:'14',55:'15',56:'16',57:'17',58:'18',59:'19',60:'20',61:'T11',62:'T12',63:'T13',
  64:'T14',65:'T15',66:'T16',67:'T17',68:'T18',69:'T19',70:'T20',71:'T13',72:'T16',73:'T19',74:'T14',75:'T13',
  76:'T20',77:'T15',78:'T18',79:'T13',80:'T20',81:'T15',82:'T14',83:'T17',84:'T20',85:'T15',86:'T18',87:'T17',
  88:'T16',89:'T19',90:'T18',91:'T17',92:'T20',93:'T19',94:'T18',95:'T19',96:'T20',97:'T19',98:'T20',100:'T20',
  101:'T19',104:'T18',107:'T19',110:'T20',
};

function randInt(maxExclusive: number) {
  return Math.floor(Math.random() * maxExclusive);
}
function getLeftNeighbor(sector: number) { return LEFT_NEIGHBORS[sector - 1]; }
function getRightNeighbor(sector: number) { return RIGHT_NEIGHBORS[sector - 1]; }

function largeTrebleTarget(targetSector: number, sectorChance: number, trebleChance: number, strayChance: number) {
  const hitSector = Math.random() < sectorChance;
  const hitTreble = Math.random() < trebleChance;
  const stray = Math.random() < strayChance;

  if (stray) {
    let cell = randInt(20);
    if (hitTreble) cell *= 3;
    return cell;
  }

  if (hitSector) {
    return hitTreble ? targetSector * 3 : targetSector;
  }

  let neighbor = getLeftNeighbor(targetSector);
  if (Math.random() < 0.5) neighbor = getRightNeighbor(targetSector);
  return hitTreble ? neighbor * 3 : neighbor;
}

function singleTarget(targetSector: number, sectorChance: number, multiplierChance: number, strayChance: number) {
  const hitSector = Math.random() < sectorChance;
  const hitMultiplier = Math.random() < multiplierChance;
  const stray = Math.random() < strayChance;

  if (stray) {
    let cell = randInt(20);
    if (hitMultiplier) cell *= 3;
    return cell;
  }

  if (hitSector) {
    return hitMultiplier ? targetSector * 3 : targetSector;
  }

  let neighbor = getLeftNeighbor(targetSector);
  if (Math.random() < 0.5) neighbor = getRightNeighbor(targetSector);
  return hitMultiplier ? neighbor * 3 : neighbor;
}

function doubleTarget(score: number, sectorChance: number, doubleChance: number, blackChance: number, strayChance: number) {
  const hitSector = Math.random() < sectorChance;
  const hitDouble = Math.random() < doubleChance;
  const stray = Math.random() < strayChance;

  if (Math.random() < blackChance) return 0;

  if (stray) {
    let cell = randInt(20);
    if (hitDouble) cell *= 2;
    if (cell > score || cell === score - 1) return -1;
    return cell;
  }

  if (hitSector) {
    if (hitDouble) return score;
    if (score / 2 === 1) return -1;
    return Math.floor(score / 2);
  }

  let neighbor = getLeftNeighbor(score / 2);
  if (Math.random() < 0.5) neighbor = getRightNeighbor(score / 2);
  const value = hitDouble ? neighbor * 2 : neighbor;
  if (value > score || value === score - 1) return -1;
  return value;
}

function rounding(score: number, dartsLeft: number, cfg: [number, number, number, number, number, number, number]) {
  let target: string | undefined;
  if (dartsLeft === 3) {
    target = CHECKOUT_3_DART[score] ?? CHECKOUT_2_DART[score];
  } else {
    target = CHECKOUT_2_DART[score] ?? CHECKOUT_3_DART[score];
  }
  if (!target) return -1;

  let throwValue: number;
  if (!target.includes('T')) {
    throwValue = singleTarget(Number(target), cfg[0], cfg[1], cfg[4]);
  } else {
    throwValue = largeTrebleTarget(Number(target.slice(1)), cfg[0], cfg[1], cfg[4]);
  }
  if (throwValue >= score - 1) return -1;
  return throwValue;
}

function checkoutThrow(dartsAlreadyThrownInTurn: number, score: number, cfg: [number, number, number, number, number, number, number]) {
  const dartsLeft = 3 - dartsAlreadyThrownInTurn;
  if (score <= 40 && score % 2 === 0) {
    return doubleTarget(score, cfg[0], cfg[2], cfg[3], cfg[4]);
  }
  return rounding(score, dartsLeft, cfg);
}

export function generateVirtualLeg(level: number, depth = 0): VirtualLegPlan {
  const lvl = Math.max(1, Math.min(12, level));
  const cfg = LEVEL_CONFIGS[lvl];

  const darts: number[] = [];
  const turns: number[] = [];
  const startScores: number[] = [];

  let score = 501;
  let dartsThrown = 0;
  let scoreAtTurnStart = 501;

  while (score !== 0) {
    startScores.push(score);

    if (score > 170) {
      const dart = largeTrebleTarget(20, cfg[0], cfg[1], cfg[4]);
      score -= dart;
      dartsThrown += 1;
      darts.push(dart);
      if (dartsThrown % 3 === 0) scoreAtTurnStart = score;
    } else {
      const dart = checkoutThrow(dartsThrown % 3, score, cfg);
      if (dart === -1) {
        dartsThrown += 1;
        darts.push(-1);
        while (dartsThrown % 3 !== 0) {
          dartsThrown += 1;
          startScores.push(score);
          darts.push(-1);
        }
        score = scoreAtTurnStart;
      } else {
        score -= dart;
        dartsThrown += 1;
        darts.push(dart);
        if (dartsThrown % 3 === 0) scoreAtTurnStart = score;
      }
    }
  }

  let tmp = 0;
  for (let i = 0; i < darts.length; i++) {
    if (darts[i] !== -1) {
      tmp += darts[i];
      if ((i + 1) % 3 === 0) {
        turns.push(tmp);
        tmp = 0;
      }
    } else {
      tmp = 0;
      if ((i + 1) % 3 === 0) {
        turns.push(tmp);
      } else {
        i += 1;
        if ((i + 1) % 3 === 0) {
          turns.push(tmp);
        } else {
          i += 1;
          if ((i + 1) % 3 === 0) {
            turns.push(tmp);
          }
        }
      }
    }
  }
  turns.push(tmp);

  const avgPerDart = 501 / darts.length;
  const [,,,,, low, high] = cfg;
  const inBand = avgPerDart <= high && avgPerDart >= low;
  const nearBand = avgPerDart < high + 7 && avgPerDart > low - 7;

  if (!inBand) {
    if (Math.random() < 0.5 && nearBand) {
      return { darts, turns, startScores, avgPerDart };
    }
    if (depth < 200) return generateVirtualLeg(lvl, depth + 1);
  }

  return { darts, turns, startScores, avgPerDart };
}
