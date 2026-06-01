const { runSql, getOne, getAll } = require('./db');

function setupTravelSockets(io) {
  io.on('connection', (socket) => {
    // 1. Join real-time room for a travel group
    socket.on('join_trip_room', async ({ groupId, username }) => {
      socket.join(`trip_${groupId}`);
      socket.currentTripId = groupId;
      socket.tripUsername = username;

      // Broadcast to other members in the room that this member is active
      socket.to(`trip_${groupId}`).emit('member_joined_room', { username });
      console.log(`[Travel Socket] ${username} joined trip room trip_${groupId}`);
    });

    // 2. High-frequency GPS location updates
    socket.on('update_location', async ({ groupId, username, lat, lng }) => {
      if (!groupId || !username || lat === undefined || lng === undefined) return;
      
      try {
        // Update DB
        await runSql(
          'UPDATE group_members SET lat = ?, lng = ?, last_updated = CURRENT_TIMESTAMP WHERE group_id = ? AND username = ?',
          [lat, lng, groupId, username]
        );

        // Fetch character color colors of the user to send along with position
        const user = await getOne(
          'SELECT char_head_color, char_hair_color, char_body_color, char_legs_color, char_shoe_color, display_name FROM users WHERE username = ?',
          [username]
        );

        // Broadcast to other members in the room
        io.to(`trip_${groupId}`).emit('location_updated', {
          username,
          displayName: user ? user.display_name : username,
          lat,
          lng,
          charColors: user ? {
            head: user.char_head_color,
            hair: user.char_hair_color,
            body: user.char_body_color,
            legs: user.char_legs_color,
            shoe: user.char_shoe_color
          } : null
        });
      } catch (err) {
        console.error('[Travel Socket] Error in update_location:', err);
      }
    });

    // 3. Emergency & refuel status alerts (SOS Panel)
    socket.on('send_status_alert', async ({ groupId, username, status }) => {
      if (!groupId || !username || !status) return;

      try {
        await runSql(
          'UPDATE group_members SET status = ?, last_updated = CURRENT_TIMESTAMP WHERE group_id = ? AND username = ?',
          [status, groupId, username]
        );

        const user = await getOne('SELECT display_name FROM users WHERE username = ?', [username]);
        const displayName = user ? user.display_name : username;

        // Broadcast alert details to everyone in the room
        io.to(`trip_${groupId}`).emit('status_alert_received', {
          username,
          displayName,
          status,
          timestamp: new Date().toISOString()
        });
        
        console.log(`[Travel Socket Alert] ${username} (${displayName}) status changed to: ${status}`);
      } catch (err) {
        console.error('[Travel Socket] Error in send_status_alert:', err);
      }
    });

    // 4. Update travel itinerary route (Leader only)
    socket.on('update_route', async ({ groupId, waypoints }) => {
      if (!groupId || !waypoints) return;

      try {
        const waypointsStr = JSON.stringify(waypoints);
        await runSql(
          'UPDATE travel_groups SET route_waypoints = ? WHERE id = ?',
          [waypointsStr, groupId]
        );

        // Broadcast new route to all group members
        io.to(`trip_${groupId}`).emit('route_updated', {
          waypoints
        });
      } catch (err) {
        console.error('[Travel Socket] Error in update_route:', err);
      }
    });

    // 5. Explicitly leaving the trip room
    socket.on('leave_trip_room', ({ groupId, username }) => {
      socket.leave(`trip_${groupId}`);
      socket.to(`trip_${groupId}`).emit('member_left_room', { username });
      console.log(`[Travel Socket] ${username} left trip room trip_${groupId}`);
    });

    // 6. Handle socket disconnects
    socket.on('disconnect', () => {
      if (socket.currentTripId && socket.tripUsername) {
        socket.to(`trip_${socket.currentTripId}`).emit('member_left_room', { username: socket.tripUsername });
        console.log(`[Travel Socket] ${socket.tripUsername} disconnected from room trip_${socket.currentTripId}`);
      }
    });
  });
}

module.exports = { setupTravelSockets };
