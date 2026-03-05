const mongoose = require('mongoose');

const rideSchema = mongoose.Schema({
  parent: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  child: { type: mongoose.Schema.Types.ObjectId, required: true }, // ID from User.children
  driver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  
  pickupLocation: { type: String, required: true },
  dropoffLocation: { type: String, required: true },
  pickupTime: { type: Date },
  
  status: { 
    type: String, 
    enum: ['requested', 'searching_driver', 'driver_assigned', 'driver_arrived', 'in_progress', 'completed', 'cancelled'],
    default: 'requested'
  },
  
  price: { type: Number, required: true },
  tripCode: { type: String }, // Generated randomly
  safeWord: { type: String },
  serviceType: { type: String, enum: ['pickup_only', 'dropoff_only', 'pickup_and_dropoff', 'stay_with_child_and_dropoff'] }
}, { timestamps: true });

module.exports = mongoose.model('Ride', rideSchema);