// backend/utils/xiDachLogic.js

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];

function createDeck() {
  const deck = [];
  for (let suit of SUITS) {
    for (let rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * Calculates the optimal score for a hand in Xì Dách.
 * Aces can be 1, 10, or 11.
 * Rule for Aces in Vietnamese Blackjack usually:
 * - 2 cards: Ace is 10 or 11.
 * - 3 cards: Ace is 10 or 1.
 * - >=4 cards: Ace is 1.
 * However, the best way is to calculate the maximum score <= 21.
 * Wait, in Vietnamese standard: 
 * - If 2 cards: A is 10 or 11.
 * - If >= 3 cards: A is 10 or 1.
 */
function calculateScore(cards) {
  let score = 0;
  let acesCount = 0;

  for (let card of cards) {
    if (['J', 'Q', 'K'].includes(card.rank)) {
      score += 10;
    } else if (card.rank === 'A') {
      acesCount += 1;
    } else {
      score += parseInt(card.rank);
    }
  }

  // Handle Aces
  for (let i = 0; i < acesCount; i++) {
    // If we only have 2 cards total, Ace can be 11 or 10. (actually A+9 = 20 (A=11), A+J = 21 (A=11 or 10))
    // A+A = Xì Bàng (handled in evaluateHand)
    // If >= 3 cards, Ace can be 10 or 1.
    // We try to add 11 if it doesn't bust, else 10, else 1.
    if (cards.length === 2) {
        if (score + 11 <= 21) {
            score += 11;
        } else if (score + 10 <= 21) {
            score += 10;
        } else {
            score += 1;
        }
    } else {
        if (score + 10 <= 21) {
            score += 10;
        } else {
            score += 1;
        }
    }
  }

  return score;
}

const HAND_TYPES = {
  XI_BANG: { name: 'Xì Bàng', weight: 6 }, // 2 Aces
  XI_DACH: { name: 'Xì Dách', weight: 5 }, // 1 Ace + 10/J/Q/K
  NGU_LINH: { name: 'Ngũ Linh', weight: 4 }, // 5 cards <= 21
  NORMAL: { name: 'Điểm', weight: 3 }, // <= 21
  QUAC: { name: 'Quắc', weight: 2 }, // > 21
  NON: { name: 'Chưa đủ tuổi', weight: 1 } // < 16 for Player, < 15 for Dealer
};

/**
 * Evaluates hand type.
 */
function evaluateHand(cards, isDealer = false) {
  const score = calculateScore(cards);
  
  if (cards.length === 2) {
    const ranks = cards.map(c => c.rank);
    if (ranks.filter(r => r === 'A').length === 2) {
      return { type: HAND_TYPES.XI_BANG, score: 21 }; // Xì Bàng
    }
    if (ranks.includes('A') && ranks.some(r => ['10', 'J', 'Q', 'K'].includes(r))) {
      return { type: HAND_TYPES.XI_DACH, score: 21 }; // Xì Dách
    }
  }

  if (score > 21) {
    return { type: HAND_TYPES.QUAC, score };
  }

  if (cards.length === 5 && score <= 21) {
    return { type: HAND_TYPES.NGU_LINH, score };
  }

  const minAge = isDealer ? 15 : 16;
  if (score < minAge) {
    return { type: HAND_TYPES.NON, score };
  }

  return { type: HAND_TYPES.NORMAL, score };
}

/**
 * Compares dealer hand vs player hand.
 * Returns:
 * 1 if Player wins
 * -1 if Dealer wins
 * 0 if Tie
 */
function compareHands(playerHand, dealerHand) {
  // If dealer Quắc and player Quắc -> Tie? In VN, usually dealer wins if both quắc, or tie. Let's make it Tie.
  if (playerHand.type === HAND_TYPES.QUAC && dealerHand.type === HAND_TYPES.QUAC) return 0;
  
  if (playerHand.type.weight > dealerHand.type.weight) return 1;
  if (playerHand.type.weight < dealerHand.type.weight) return -1;
  
  // Same type
  if (playerHand.type === HAND_TYPES.NORMAL) {
    if (playerHand.score > dealerHand.score) return 1;
    if (playerHand.score < dealerHand.score) return -1;
    return 0; // Tie
  }

  if (playerHand.type === HAND_TYPES.NGU_LINH) {
    // Both Ngu Linh -> lower score wins in VN rules!
    if (playerHand.score < dealerHand.score) return 1;
    if (playerHand.score > dealerHand.score) return -1;
    return 0;
  }

  // Both Xi Dach or Xi Bang -> Tie
  return 0;
}

module.exports = {
  createDeck,
  shuffle,
  calculateScore,
  evaluateHand,
  compareHands,
  HAND_TYPES
};
