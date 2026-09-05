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
