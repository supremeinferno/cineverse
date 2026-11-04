# 🎬 CineVerse AI

CineVerse AI is a movie recommendation platform that combines content-based filtering with live TMDB data to help users discover movies tailored to their interests.

The application provides real-time search, detailed movie information, trending titles, and personalized recommendations through an interactive web interface served by FastAPI.

## Live Demo

https://supremeinferno-movies-recommender.streamlit.app

## Features

- Intelligent movie recommendations using TF-IDF similarity
- Genre-based recommendation engine
- Real-time movie search
- Trending, Top Rated, Upcoming, and Now Playing feeds
- Detailed movie information pages
- TMDB API integration
- Modern responsive user interface
- Full-screen 3D poster carousel built with Three.js
- FastAPI-powered backend services

## Tech Stack

**Frontend**
- HTML/CSS
- Vanilla JavaScript
- Three.js

**Backend**
- FastAPI
- Uvicorn

**Machine Learning**
- Scikit-Learn
- TF-IDF Vectorization
- Cosine Similarity

**Data Source**
- TMDB API

## System Architecture

```text
User
 │
 ▼
HTML/JS Frontend (served by FastAPI)
 │
 ▼
FastAPI Backend
 │
 ├── Recommendation Engine
 │      ├── TF-IDF Similarity
 │      └── Genre Matching
 │
 ▼
TMDB API
```

## Running Locally

```bash
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
echo "TMDB_API_KEY=your_key" > .env
.venv/bin/python -m uvicorn main:app --reload
```

Then open http://127.0.0.1:8000 (API docs are at `/docs`). Python 3.11 is required: the pinned packages don't install on 3.14.

## Recommendation Approach

### Content-Based Filtering
Movies are represented using TF-IDF vectors generated from metadata and textual features. The opened movie's live TMDB details are vectorized with the trained model, so movies newer than the dataset get recommendations too. Cosine similarity is weighted by popularity and limited to shared genres.

### TMDB Related Movies
"More Like This" uses TMDB's own recommendations, falling back to its similar-movie and genre-discovery results.

## Screenshots

### Home Page
_Add screenshot_

### Search Experience
_Add screenshot_

### Movie Details & Recommendations
_Add screenshot_

## Future Improvements

- User authentication
- Watchlists
- Collaborative filtering
- Hybrid recommendation system
- Personalized recommendation history
- AI-powered movie assistant

## Author

Pranav Garg

GitHub: https://github.com/supremeinferno