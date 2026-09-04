from app.services.compare import compare_observations


def obs(value, source="source-a", attribute="height"):
    return {"object_key": "platform-1", "attribute": attribute, "value": value, "unit": "mm", "source_key": source}


def test_new_observation():
    result = compare_observations([], [obs(760)])
    assert len(result["new"]) == 1


def test_unchanged_observation():
    result = compare_observations([obs(760)], [obs(760)])
    assert len(result["unchanged"]) == 1


def test_changed_value_from_same_source():
    result = compare_observations([obs(550)], [obs(760)])
    assert len(result["changed"]) == 1


def test_conflicting_value_from_different_source():
    result = compare_observations([obs(550, "source-a")], [obs(760, "source-b")])
    assert len(result["conflicts"]) == 1
    assert result["conflicts"][0]["existing"][0]["value"] == 550


def test_same_value_from_new_source_is_stored_as_new_provenance():
    result = compare_observations([obs(760, "source-a")], [obs(760, "source-b")])
    assert result["new"] == [obs(760, "source-b")]


def test_return_to_historical_value_is_a_change_against_latest_value():
    stored = [obs(550), obs(760)]
    result = compare_observations(stored, [obs(550)])
    assert len(result["changed"]) == 1
