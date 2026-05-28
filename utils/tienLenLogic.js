const ranks = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const suits = ['S', 'C', 'D', 'H'];

function createDeck() {
  const deck = [];
  for (const r of ranks) {
    for (const s of suits) {
      deck.push(`${r}${s}`);
    }
  }
  return deck;
}

function shuffle(deck) {
  const newDeck = [...deck];
  for (let i = newDeck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newDeck[i], newDeck[j]] = [newDeck[j], newDeck[i]];
  }
  return newDeck;
}

function getCardValue(card) {
  const r = card.slice(0, -1);
  const s = card.slice(-1);
  return ranks.indexOf(r) * 4 + suits.indexOf(s);
}

function sortCards(cards) {
  return [...cards].sort((a, b) => getCardValue(a) - getCardValue(b));
}

function evaluateCombo(cards) {
  if (!cards || cards.length === 0) return null;
  const sorted = sortCards(cards);
  const len = sorted.length;
  const highestValue = getCardValue(sorted[len - 1]);
  const rankIndices = sorted.map(c => ranks.indexOf(c.slice(0, -1)));

  // 1 card
  if (len === 1) return { type: 'single', value: highestValue, length: 1 };

  // 2 cards
  if (len === 2 && rankIndices[0] === rankIndices[1]) {
    return { type: 'pair', value: highestValue, length: 2 };
  }

  // 3 cards
  if (len === 3 && rankIndices[0] === rankIndices[1] && rankIndices[1] === rankIndices[2]) {
    return { type: 'triple', value: highestValue, length: 3 };
  }

  // 4 cards
  if (len === 4 && rankIndices[0] === rankIndices[1] && rankIndices[1] === rankIndices[2] && rankIndices[2] === rankIndices[3]) {
    return { type: 'four', value: highestValue, length: 4 };
  }

  // Straight
  let isStraight = len >= 3;
  for (let i = 0; i < len - 1; i++) {
    if (rankIndices[i] + 1 !== rankIndices[i + 1] || rankIndices[i] === 12 || rankIndices[i + 1] === 12) {
      isStraight = false;
      break;
    }
  }
  if (isStraight) {
    return { type: 'straight', length: len, value: highestValue };
  }

  // Thong
  if (len >= 6 && len % 2 === 0) {
    let isThong = true;
    let numPairs = len / 2;
    for (let i = 0; i < numPairs; i++) {
      if (rankIndices[i * 2] !== rankIndices[i * 2 + 1]) {
        isThong = false; break;
      }
      if (i > 0 && (rankIndices[i * 2] !== rankIndices[(i - 1) * 2] + 1 || rankIndices[i*2] === 12)) {
        isThong = false; break;
      }
    }
    if (isThong) {
      return { type: 'thong', pairs: numPairs, value: highestValue, length: len };
    }
  }

  return null;
}

function canBeat(comboToPlay, lastCombo) {
  if (!lastCombo) return true;
  
  if (comboToPlay.type === lastCombo.type) {
    if (comboToPlay.type === 'straight' && comboToPlay.length !== lastCombo.length) return false;
    if (comboToPlay.type === 'thong' && comboToPlay.pairs !== lastCombo.pairs) return false;
    return comboToPlay.value > lastCombo.value;
  }

  const lastIsPig = lastCombo.type === 'single' && lastCombo.value >= 48;
  const lastIsPigPair = lastCombo.type === 'pair' && lastCombo.value >= 48;

  if (lastIsPig) {
    if (comboToPlay.type === 'thong' && comboToPlay.pairs >= 3) return true;
    if (comboToPlay.type === 'four') return true;
  }
  
  if (lastIsPigPair) {
    if (comboToPlay.type === 'four') return true;
    if (comboToPlay.type === 'thong' && comboToPlay.pairs >= 4) return true;
  }

  if (lastCombo.type === 'thong' && lastCombo.pairs === 3) {
    if (comboToPlay.type === 'four') return true;
    if (comboToPlay.type === 'thong' && comboToPlay.pairs >= 4) return true;
  }
  
  if (lastCombo.type === 'four') {
    if (comboToPlay.type === 'thong' && comboToPlay.pairs >= 4) return true;
  }

  return false;
}

function getSubsetsOfLength(array, k) {
  const result = [];
  function backtrack(start, current) {
    if (current.length === k) {
      result.push([...current]);
      return;
    }
    for (let i = start; i < array.length; i++) {
      current.push(array[i]);
      backtrack(i + 1, current);
      current.pop();
    }
  }
  backtrack(0, []);
  return result;
}

function botOpeningPlay(sorted) {
  if (sorted.length <= 1) return sorted;

  const has2 = (cards) => cards.some(c => c.slice(0, -1) === '2');

  // Group cards by rank
  const rankGroups = {};
  for (const card of sorted) {
    const r = card.slice(0, -1);
    if (!rankGroups[r]) rankGroups[r] = [];
    rankGroups[r].push(card);
  }

  // 1. Try shortest straight using non-2 cards
  const nonPigCards = sorted.filter(c => c.slice(0, -1) !== '2');
  if (nonPigCards.length >= 3) {
    for (let len = 3; len <= Math.min(nonPigCards.length, 6); len++) {
      const subsets = getSubsetsOfLength(nonPigCards, len);
      for (const sub of subsets) {
        const combo = evaluateCombo(sub);
        if (combo && combo.type === 'straight') {
          return sub;
        }
      }
      if (len === 3) break; // prefer shortest straight, stop after checking 3-card straights
    }
  }

  // 2. Try lowest pair (avoid 2s)
  for (const r of ranks) {
    if (r === '2') continue;
    if (rankGroups[r] && rankGroups[r].length >= 2) {
      return rankGroups[r].slice(0, 2);
    }
  }

  // 3. Play lowest single (avoid 2s if possible)
  return [nonPigCards.length > 0 ? nonPigCards[0] : sorted[0]];
}

function botPlay(hand, lastCombo) {
  const sorted = sortCards(hand);
  
  if (!lastCombo) {
    return botOpeningPlay(sorted);
  }

  let candidates = [];
  
  if (lastCombo.length <= sorted.length) {
    const subsets = getSubsetsOfLength(sorted, lastCombo.length);
    for (const sub of subsets) {
      const combo = evaluateCombo(sub);
      if (combo && canBeat(combo, lastCombo)) {
        candidates.push({ cards: sub, value: combo.value });
      }
    }
  }
  
  const lastIsPig = lastCombo.type === 'single' && lastCombo.value >= 48;
  const lastIsPigPair = lastCombo.type === 'pair' && lastCombo.value >= 48;
  
  if (lastIsPig || lastIsPigPair || lastCombo.type === 'thong') {
    for (const len of [4, 6, 8]) {
      if (sorted.length >= len) {
        const subsets = getSubsetsOfLength(sorted, len);
        for (const sub of subsets) {
          const combo = evaluateCombo(sub);
          if (combo && canBeat(combo, lastCombo)) {
            candidates.push({ cards: sub, value: combo.value });
          }
        }
      }
    }
  }

  if (candidates.length === 0) return [];

  // Sort: prefer combos without 2s (penalize by +100 to push them to the end)
  candidates.sort((a, b) => {
    const aHas2 = a.cards.some(c => c.slice(0, -1) === '2') ? 100 : 0;
    const bHas2 = b.cards.some(c => c.slice(0, -1) === '2') ? 100 : 0;
    return (a.value + aHas2) - (b.value + bHas2);
  });
  
  return candidates[0].cards;
}

module.exports = {
  createDeck,
  shuffle,
  sortCards,
  evaluateCombo,
  canBeat,
  botPlay,
  getCardValue
};
