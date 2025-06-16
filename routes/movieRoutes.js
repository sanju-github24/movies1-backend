import express from 'express';
import { getMovieModel } from '../models/Movie.js';
import { moviesConnection } from '../config/mongodb.js';
import { generateSummary } from '../controllers/aiController.js';

const router = express.Router();

const getModel = () => {
  if (!moviesConnection) throw new Error("moviesConnection is not initialized yet");
  return getMovieModel(moviesConnection);
};

// ✅ POST /api/movies/upload with auto-delete logic
router.post('/', async (req, res) => {
  try {
    const Movie = getModel();

    const newMovie = new Movie(req.body);
    await newMovie.save();

    // 🔁 Auto-delete logic: Keep only latest 150 movies
    const totalCount = await Movie.countDocuments();
    if (totalCount > 160) {
      const extraCount = totalCount - 150;
      const oldestMovies = await Movie.find().sort({ uploadedAt: 1 }).limit(extraCount);
      const idsToDelete = oldestMovies.map(m => m._id);
      await Movie.deleteMany({ _id: { $in: idsToDelete } });
    }

    res.status(201).json({ success: true, data: newMovie });
  } catch (err) {
    console.error('Upload Error:', err.message);
    res.status(500).json({ success: false, error: 'Upload failed' });
  }
});

// ✅ GET /api/movies
router.get('/', async (req, res) => {
  try {
    const Movie = getModel();
    const movies = await Movie.find().sort({ uploadedAt: -1 }); // newest first
    res.status(200).json({ success: true, data: movies });
  } catch (err) {
    console.error('Fetch Error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch movies' });
  }
});

router.post('/generate-summary', generateSummary);






router.get('/:slug', async (req, res) => {
  try {
    const Movie = getModel();
    const movie = await Movie.findOne({ slug: req.params.slug });

    if (!movie) {
      return res.status(404).json({ success: false, error: 'Movie not found' });
    }

    res.status(200).json({ success: true, data: movie });
  } catch (err) {
    console.error('Fetch movie error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch movie' });
  }
});

// ✅ PUT /api/movies/:slug
router.put('/:slug', async (req, res) => {
  try {
    const Movie = getModel();
    const updatedMovie = await Movie.findOneAndUpdate(
      { slug: req.params.slug },
      req.body,
      { new: true }
    );
    res.status(200).json({ success: true, data: updatedMovie });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Update failed' });
  }
});
// DELETE /api/movies/:slug
router.delete('/:slug', async (req, res) => {
  try {
    const Movie = getModel();
    const deleted = await Movie.findOneAndDelete({ slug: req.params.slug });

    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Movie not found' });
    }

    res.status(200).json({ success: true, message: 'Movie deleted successfully' });
  } catch (err) {
    console.error('Delete Error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to delete movie' });
  }
});





export default router;
