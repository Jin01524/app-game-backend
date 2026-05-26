function parseJSON(str, def) {
  try {
    return str ? JSON.parse(str) : def;
  } catch (e) {
    return def;
  }
}

function addToBackpack(backpack, itemId, qty, maxSlots = 16) {
  let remaining = qty;
  // Fill existing slots
  for (let i = 0; i < maxSlots; i++) {
    if (backpack[i] && backpack[i].item_id === itemId && backpack[i].quantity < 64) {
      let space = 64 - backpack[i].quantity;
      let add = Math.min(remaining, space);
      backpack[i].quantity += add;
      remaining -= add;
      if (remaining <= 0) return { success: true, backpack, remaining: 0 };
    }
  }
  // Find empty slots
  for (let i = 0; i < maxSlots; i++) {
    if (!backpack[i]) {
      let add = Math.min(remaining, 64);
      backpack[i] = { item_id: itemId, quantity: add };
      remaining -= add;
      if (remaining <= 0) return { success: true, backpack, remaining: 0 };
    }
  }
  return { success: remaining <= 0, backpack, remaining };
}

function removeFromBackpack(backpack, itemId, qty) {
  let remaining = qty;
  for (let i = backpack.length - 1; i >= 0; i--) { // try to remove from rightmost slots first
    if (backpack[i] && backpack[i].item_id === itemId) {
      if (backpack[i].quantity > remaining) {
        backpack[i].quantity -= remaining;
        remaining = 0;
        return { success: true, backpack };
      } else {
        remaining -= backpack[i].quantity;
        backpack[i] = null;
      }
    }
  }
  return { success: remaining <= 0, backpack };
}

function getBackpackItemCount(backpack, itemId) {
  return backpack.reduce((sum, slot) => sum + (slot && slot.item_id === itemId ? slot.quantity : 0), 0);
}

module.exports = {
  parseJSON,
  addToBackpack,
  removeFromBackpack,
  getBackpackItemCount
};
