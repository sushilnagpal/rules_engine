Feature: Alarm status changes

  Scenario: Alarm is disarmed
    Given the alarm state changes to "Disarm"
    Then a message reading "Alarm disarmed" is sent to "everyone"
    And the "Kitchen" speaker says "Alarm is disarmed"

  Scenario: Alarm is armed home
    Given the alarm state changes to "Home"
    Then a message reading "Alarm armed Home" is sent to "everyone"

  Scenario: Alarm is armed away
    Given the alarm state changes to "Away"
    Then a message reading "Alarm armed Away" is sent to "everyone"
