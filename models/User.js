const mongoose = require('mongoose');

const childSchema = mongoose.Schema({
  name: { type: String, required: true },
  age: { type: Number, required: true },
  notes: { type: String },
  photoUrl: { type: String }
});

const userSchema = mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['parent', 'driver', 'admin'], default: 'parent' },
  phone: { type: String },
  photoUrl: { type: String },
  children: [childSchema],
  
  // Driver Specific Fields
  isVerifiedDriver: { type: Boolean, default: false },
  driverApplicationStatus: { type: String, enum: ['none', 'pending', 'approved', 'rejected'], default: 'none' },
  vehicle: {
    make: String,
    model: String,
    color: String,
    plate: String,
    year: String
  }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);