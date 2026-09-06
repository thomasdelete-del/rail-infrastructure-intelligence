from app.services import aerial_learning


def test_learning_waits_for_both_classes_and_minimum_samples(monkeypatch):
    monkeypatch.setattr(aerial_learning, "training_samples", lambda: [
        {"accepted": True, "features": {"prominence": 4, "termination_ratio": 2, "shift_m": 1}}
    ])
    assert aerial_learning.learned_probability({"prominence": 4}) == (None, 1)


def test_online_classifier_learns_positive_and_negative_examples(monkeypatch):
    samples = []
    for _ in range(4):
        samples.append({"accepted": True, "features": {
            "prominence": 6, "termination_ratio": 3.5, "shift_m": 2, "paired_corridor": True}})
        samples.append({"accepted": False, "features": {
            "prominence": 1.5, "termination_ratio": 1.1, "shift_m": 90, "paired_corridor": False}})
    monkeypatch.setattr(aerial_learning, "training_samples", lambda: samples)

    positive, count = aerial_learning.learned_probability(
        {"prominence": 6, "termination_ratio": 3.5, "shift_m": 2, "paired_corridor": True})
    negative, _ = aerial_learning.learned_probability(
        {"prominence": 1.5, "termination_ratio": 1.1, "shift_m": 90, "paired_corridor": False})

    assert count == 8
    assert positive is not None and negative is not None and positive > negative


def test_latest_manual_correction_wins(monkeypatch):
    monkeypatch.setattr(aerial_learning, "training_samples", lambda: [
        {"track": "5", "endpoint": "start", "corrected_coordinate": {"latitude": 50.1, "longitude": 8.1}},
        {"track": "5", "endpoint": "start", "corrected_coordinate": {"latitude": 50.2, "longitude": 8.2}},
    ])
    assert aerial_learning.latest_correction("5", "start") == {"latitude": 50.2, "longitude": 8.2}
    assert aerial_learning.latest_correction("5", "end") is None


def test_clear_marker_supersedes_an_incorrect_coordinate(monkeypatch):
    monkeypatch.setattr(aerial_learning, "training_samples", lambda: [
        {"track": "7", "endpoint": "start", "corrected_coordinate": {"latitude": 50.3, "longitude": 8.7}},
        {"track": "7", "endpoint": "start", "clear_corrected_coordinate": True},
    ])
    assert aerial_learning.latest_correction("7", "start") is None


def test_accepted_endpoint_is_stored_as_separate_confirmed_observation(monkeypatch):
    captured = []
    monkeypatch.setattr(aerial_learning, "store_observations", lambda items: captured.extend(items) or len(items))
    stored = aerial_learning.store_training_sample(
        "8", "end", True, {"prominence": 5}, confirmed_coordinate={"latitude": 50.3, "longitude": 8.7})
    assert stored == 2
    assert captured[0]["attribute"] == aerial_learning.ATTRIBUTE
    assert captured[1]["attribute"] == "confirmed_end_coordinates"
    assert captured[1]["value"] == {"latitude": 50.3, "longitude": 8.7}
    assert captured[1]["method"] == "manual_confirmation"
