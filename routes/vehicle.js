const express = require('express');
const router = express.Router();
const { getOne, runSql, logActivity } = require('../db');

const VEHICLE_PRICES = {
  Motorcycle_red: 500,
  large_displacement_motorcycles_red: 1000,
  old_car_white: 1200,
  cheap_car_white: 1500,
  'cheap_car_Dark-Blue-Grey': 1600,
  vf3_red: 2000,
  vf3_blue: 2000,
  vf3_yellow: 2000
};

// POST /api/vehicle/buy
router.post('/buy', async (req, res) => {
  const userId = req.user.id;
  const { vehicleId } = req.body;

  const price = VEHICLE_PRICES[vehicleId];
  if (!price) {
    return res.status(400).json({ error: 'Loại xe không hợp lệ' });
  }

  const user = await getOne('SELECT xu, vehicle_skins FROM users WHERE id = ?', [userId]);
  if (!user) {
    return res.status(404).json({ error: 'Người dùng không tồn tại' });
  }

  if (user.xu < price) {
    return res.status(400).json({ error: 'Không đủ xu để mua xe này' });
  }

  let skins = [];
  try {
    skins = JSON.parse(user.vehicle_skins || '["Motorcycle_orange"]');
  } catch (e) {
    skins = ['Motorcycle_orange'];
  }

  if (skins.includes(vehicleId)) {
    return res.status(400).json({ error: 'Bạn đã sở hữu loại xe này rồi' });
  }

  skins.push(vehicleId);
  const newXu = user.xu - price;

  await runSql('UPDATE users SET xu = ?, vehicle_skins = ? WHERE id = ?', [newXu, JSON.stringify(skins), userId]);
  await logActivity(req.user.username, 'buy_vehicle', `Mua xe ${vehicleId}`, -price);

  res.json({
    message: 'Mua xe thành công',
    xu: newXu,
    vehicleSkins: skins
  });
});

// POST /api/vehicle/equip
router.post('/equip', async (req, res) => {
  const userId = req.user.id;
  const { vehicleId } = req.body;

  if (vehicleId !== 'Motorcycle_orange' && !VEHICLE_PRICES[vehicleId]) {
    return res.status(400).json({ error: 'Loại xe không hợp lệ' });
  }

  const user = await getOne('SELECT vehicle_skins FROM users WHERE id = ?', [userId]);
  if (!user) {
    return res.status(404).json({ error: 'Người dùng không tồn tại' });
  }

  let skins = [];
  try {
    skins = JSON.parse(user.vehicle_skins || '["Motorcycle_orange"]');
  } catch (e) {
    skins = ['Motorcycle_orange'];
  }

  if (!skins.includes(vehicleId)) {
    return res.status(400).json({ error: 'Bạn chưa sở hữu loại xe này' });
  }

  await runSql('UPDATE users SET equipped_vehicle_skin = ? WHERE id = ?', [vehicleId, userId]);
  res.json({
    message: 'Trang bị xe thành công',
    equippedVehicleSkin: vehicleId
  });
});

module.exports = router;
