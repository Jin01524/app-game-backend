const settingsManager = require('./settingsManager');

function simulateCowProgress(animalsData, cageInventory, now) {
  let drops = [];
  let updated = false;

  animalsData.forEach(animal => {
    if (animal.type !== 'cow') return;
    
    // Migration from old data format
    if (animal.lastMilkTime && !animal.lastUpdateTime) {
      const elapsedSinceMilk = Math.max(0, (now - animal.lastMilkTime) / 1000);
      animal.milkProgress = elapsedSinceMilk;
      animal.strawTimeRemaining = 0; // Requires straw now
      animal.lastUpdateTime = now;
      delete animal.lastMilkTime;
      updated = true;
    }

    if (!animal.lastUpdateTime) {
      animal.lastUpdateTime = now;
      animal.milkProgress = 0;
      animal.strawTimeRemaining = 0;
      updated = true;
    }

    let elapsedSec = (now - animal.lastUpdateTime) / 1000;
    
    while (elapsedSec > 0) {
      // If no straw buff remaining, try to consume a straw
      if ((animal.strawTimeRemaining || 0) <= 0) {
        let consumed = false;
        for (let i = 0; i < cageInventory.length; i++) {
          if (cageInventory[i] && cageInventory[i].item_id === 'rom' && cageInventory[i].quantity > 0) {
            cageInventory[i].quantity -= 1;
            if (cageInventory[i].quantity <= 0) {
              cageInventory[i] = null; // Clear slot if empty
            }
            consumed = true;
            break;
          }
        }
        
        if (consumed) {
          const strawTime = settingsManager.getSetting('farm_cow_straw_time', 900);
          animal.strawTimeRemaining = (animal.strawTimeRemaining || 0) + strawTime;
          updated = true;
        } else {
          // No straw available, pause here
          break;
        }
      }

      // We have straw time. Progress by the smallest chunk.
      const milkTime = settingsManager.getSetting('farm_cow_milk_time', 1800);
      const timeToMilk = milkTime - (animal.milkProgress || 0);
      const step = Math.min(elapsedSec, animal.strawTimeRemaining, timeToMilk);

      animal.strawTimeRemaining -= step;
      animal.milkProgress = (animal.milkProgress || 0) + step;
      elapsedSec -= step;
      updated = true;

      // Check if milk is produced
      if (animal.milkProgress >= settingsManager.getSetting('farm_cow_milk_time', 1800)) {
        animal.milkProgress = 0; // reset progress
        drops.push('milk');
      }
    }
    
    // Ensure the cow is synced to current time even if paused
    animal.lastUpdateTime = now;
  });

  return { updated, animalsData, cageInventory, drops };
}

module.exports = { simulateCowProgress };
