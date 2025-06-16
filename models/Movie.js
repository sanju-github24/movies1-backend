import mongoose from 'mongoose';


const downloadSchema = new mongoose.Schema({
  quality: String,
  size: String,
  format: String,
  torrent: String,
  magnet: String,
});

const movieSchema = new mongoose.Schema({
  id: String,
  slug: { type: String, required: true, unique: true },
  title: String,
  poster: String,
  description: String,
  categories: [String],
  subCategory: [String],
  language: [String],
  createdAt: { type: Date, default: Date.now },
  
  downloads: [downloadSchema],
  uploadedBy: { type: String, required: false },
  uploadedAt: {
    type: Date,
    default: Date.now,
  },
});
export const getMovieModel = (moviesConnection) => {
    return moviesConnection.model("Movie", movieSchema);
  };
  



