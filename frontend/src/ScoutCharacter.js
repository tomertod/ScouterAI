import scoutImage from './Scout.png';

function ScoutCharacter() {
  return (
    <div className="scout-character" aria-label="Scout mascot">
      <img
        src={scoutImage}
        alt="Scout, your job search assistant"
        className="scout-character__image"
      />
      <div className="scout-speech-bubble" role="note">
        <p>Meet Scout! He is here to help you find your next position.</p>
      </div>
    </div>
  );
}

export default ScoutCharacter;
