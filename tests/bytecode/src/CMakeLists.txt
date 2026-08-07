cmake_minimum_required(VERSION 3.10)
set(TARGET bytecode_tests)

# ==================================================================================================
# Sources
# ==================================================================================================
file(GLOB SOURCES
	${CMAKE_CURRENT_SOURCE_DIR}/*.c
)

# ==================================================================================================
# Target
# ==================================================================================================
set(TEST_TARGETS "")
foreach(SOURCE ${SOURCES})
	get_filename_component(TEST_NAME ${SOURCE} NAME_WE)
	set(TEST_TARGET test_bytecode_${TEST_NAME})

	add_executable(${TEST_TARGET} ${SOURCE})
	set_target_properties(${TEST_TARGET} PROPERTIES DEBUG_POSTFIX d)
	list(APPEND TEST_TARGETS ${TEST_TARGET})
endforeach()

add_custom_target(${TARGET} DEPENDS ${TEST_TARGETS})

# ==================================================================================================
# Libraries
# ==================================================================================================
foreach(TEST_TARGET ${TEST_TARGETS})
	target_link_libraries(${TEST_TARGET} PRIVATE bytecode_test_common)
endforeach()

# ==================================================================================================
# Custom commands
# ==================================================================================================
if (WIN32)
	foreach(TEST_TARGET ${TEST_TARGETS})
		add_custom_command(
			TARGET ${TEST_TARGET} POST_BUILD
			COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_FILE:empathy> $<TARGET_FILE_DIR:${TEST_TARGET}>
		)
	endforeach()
endif()

# ==================================================================================================
# Tests
# ==================================================================================================
foreach(TEST_TARGET ${TEST_TARGETS})
	add_test(NAME ${TEST_TARGET} COMMAND ${TEST_TARGET})
endforeach()
